import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, generationJobs } from "../db/schema.js";
import { env } from "../lib/env.js";
import { normalizeStudioChatReferences } from "../lib/studio-image-references.js";
import { normalizeImageProposal } from "../lib/studio-tools/image-proposal.js";
import type { LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop, agentRoutes } from "./agent.js";
import type { AppEnv } from "../lib/types.js";

test("an alternate agent's automatic background image preserves uploaded references", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  const previous = env.YUMINA_STUDIO_CODEX_ENABLED;
  const previousEdition = env.YUMINA_EDITION;
  env.YUMINA_EDITION = "local";
  env.YUMINA_STUDIO_CODEX_ENABLED = true;
  t.after(async () => { env.YUMINA_STUDIO_CODEX_ENABLED = previous; env.YUMINA_EDITION = previousEdition; await db.delete(user).where(eq(user.id, uid)); });
  const world = migrateWorldDefinition({ id: wid, version: "19.0.0", name: "Reference QA", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Reference QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "alternate-agent", status: "running" });
  const [ref] = normalizeStudioChatReferences(uid, [{ key: `studio-chat/${uid}/12345678-1234-1234-1234-123456789abc.png`, name: "star.png", mimeType: "image/png" }]);
  let calls = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    assert.doesNotMatch(JSON.stringify(request.messages), /"image_url"/, "Text-only main agent does not receive unsupported image parts");
    assert.match(JSON.stringify(request.messages), /Codex image helper receives the actual image/);
    if (calls++ === 0) {
      yield { type: "text", content: "I will generate a blue version of your reference." };
      yield { type: "done", content: "", stopReason: "max_tokens" };
      return;
    }
    if (calls > 2) { yield { type: "text", content: "The referenced image is drawing in the background." };yield { type: "done", content: "", stopReason: "end_turn" };return; }
    yield { type: "tool_call_end", content: "", toolCall: { id: "ref-image", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "Make the reference blue", imageKind: "sprite", referenceImages: [{ key: "invented", url: "https://wrong.example", name: "wrong" }] }) } } };
    yield { type: "done", content: "", stopReason: "tool_use" };
  } };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId: rid, conversationId: rid, worldId: wid, userId: uid, world,
    messages: [{ role: "user", content: [{ type: "text", text: "Make my uploaded star blue" }, { type: "image_url", image_url: { url: ref!.url } }] }],
    model: "deepseek/deepseek-v4-flash", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 3, tools: STUDIO_TOOLS }));
  const response = await app.request("/test"), events = await response.text();
  assert.doesNotMatch(events, /event: error/); assert.match(events, /event: image_proposal/);
  const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, rid));
  assert.equal(saved!.status, "completed");
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.userId, uid));
  const args = job!.params.proposal as any;
  assert.equal(args.source, "codex"); assert.equal(args.referenceImages[0].key, ref!.key);
  assert.equal(args.referenceImages.length, 1, "The host selects actual chat references, ignoring invented tool arguments");
  assert.equal(calls, 3, "A harness retry preserves the original reference, then the agent continues after queueing");
  const edited = normalizeImageProposal({ ...args, prompt: "Make the star cyan instead" });
  assert.deepEqual(edited?.referenceImages, args.referenceImages);
});

test("agent start rejects another user's reference before resolving a provider", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Reference owner", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "Reference owner", schema: {} });
  t.after(() => db.delete(user).where(eq(user.id, uid)));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of agentRoutes.routes.filter(r => r.method === "POST" && r.path === "/:worldId/agent/start")) app.post(route.path, route.handler);
  const response = await app.request(`/${wid}/agent/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Use this", attachments: [{ key: "studio-chat/someone-else/12345678-1234-1234-1234-123456789abc.png", url: "https://wrong.example", mimeType: "image/png", name: "other.png" }] }) });
  assert.equal(response.status, 400); assert.equal((await response.json() as any).code, "INVALID_REFERENCE");
});

test("batch confirmation cannot silently omit uploaded image references", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Batch reference QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "Batch reference QA", schema: {} });
  t.after(() => db.delete(user).where(eq(user.id, uid)));
  const [ref] = normalizeStudioChatReferences(uid, [{ key: `studio-chat/${uid}/12345678-1234-1234-1234-123456789abc.png`, name: "ref.png", mimeType: "image/png" }]);
  await db.insert(agentRuns).values({ id: rid, worldId: wid, userId: uid, model: "batch-test", status: "awaiting_approval",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: ref!.url } }] }] });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of agentRoutes.routes.filter(r => r.method === "POST" && r.path === "/:worldId/agent/generate-images")) app.post(route.path, route.handler);
  const response = await app.request(`/${wid}/agent/generate-images`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: rid, approved: true }) });
  assert.equal(response.status, 400); assert.equal((await response.json() as any).code, "UNSUPPORTED_REFERENCES");
  const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, rid));
  assert.equal(saved!.status, "awaiting_approval", "No image job is started and the pending request stays recoverable");
});
