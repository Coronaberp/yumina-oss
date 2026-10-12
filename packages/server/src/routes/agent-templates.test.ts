import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns } from "../db/schema.js";
import type { GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { readTemplateContent } from "../lib/studio-skills/index.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";

test("Studio's streaming loop returns official template source to the model without modifying the card", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Template access must not call external services"); });
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID(); const runId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Template read test", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Template test", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "template-test", status: "running" });
  const before = (await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId)))[0]!.schema;
  let calls = 0;
  const resultFor = (request: GenerateParams, id: string) => {
    const result = request.messages.find(message => message.role === "tool" && message.tool_call_id === id);
    assert.ok(result, `Missing template tool result ${id}`);
    return JSON.parse(String(result.content));
  };
  const provider: LLMProvider = {
    listModels: async () => [],
    async *generateStream(request) {
      calls++;
      assert.ok(request.tools?.some(tool => tool.function.name === "list_templates"));
      assert.match(JSON.stringify(request.messages[0]), /vn-scene-engine/);
      if (calls === 1) {
        yield { type: "tool_call_end", content: "", toolCall: { id: "catalog", type: "function", function: { name: "list_templates", arguments: "{}" } } };
      } else if (calls === 2) {
        assert.match(resultFor(request, "catalog").summary, /vn-scene-engine/);
        yield { type: "tool_call_end", content: "", toolCall: { id: "source", type: "function", function: { name: "list_templates", arguments: JSON.stringify({ id: "vn-scene-engine" }) } } };
      } else if (calls === 3) {
        const template = resultFor(request, "source");
        assert.equal(template.id, "vn-scene-engine");
        assert.equal(template.meta.name, "Visual Novel Scene Engine");
        assert.equal(template.content, readTemplateContent("vn-scene-engine"));
        yield { type: "tool_call_end", content: "", toolCall: { id: "unknown", type: "function", function: { name: "list_templates", arguments: JSON.stringify({ id: "../../.env" }) } } };
      } else {
        assert.equal(calls, 4);
        const missing = resultFor(request, "unknown");
        assert.match(missing.error, /Official template not found/);
        assert.equal(missing.content, undefined);
        yield { type: "text", content: "Read the official VN template." };
      }
      yield { type: "done", content: "", stopReason: calls < 4 ? "tool_use" : "end_turn" };
    },
  };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
    messages: [{ role: "user", content: "Read the official VN template without changing my card." }],
    model: "template-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true,
    iteration: 0, maxIterations: 5, tools: STUDIO_TOOLS }));
  const response = await app.request("/test");
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(stream, /event: error/);
  assert.doesNotMatch(stream, /event: proposal/);
  assert.match(stream, /event: read_tools_executed/);
  assert.match(stream, /"name":"list_templates","status":"success"/);
  assert.match(stream, /"name":"list_templates","status":"error"/);
  assert.equal(calls, 4);
  const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
  assert.equal(run.status, "completed");
  assert.deepEqual((await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId)))[0]!.schema, before);
});
