import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns } from "../db/schema.js";
import type { LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";
import { executeGenerateNames } from "../lib/studio-tools/name-generator.js";
import { executeStudioGenerateNames } from "../lib/studio-tools/name-registry.js";

async function runNamingRequest(prompt: string, provider: LLMProvider) {
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID(); const runId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Naming test", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Naming test", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "names-test", status: "running" });
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
    messages: [{ role: "user", content: prompt }], model: "names-test", provider,
    isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS }));
  const response = await app.request("/test");
  const stream = await response.text();
  const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
  const after = (await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId)))[0]!.schema;
  return { stream, run, before: world, after };
}

test("names-only requests force the local tool and return its names without model substitutions or writes", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Naming must remain local"); });
  let calls = 0;
  const args = { style: "persian", gender: "feminine", count: 5, seed: "names-test" };
  const provider: LLMProvider = {
    listModels: async () => [],
    async *generateStream(request) {
      calls++;
      assert.ok(request.tools?.some(tool => tool.function.name === "generate_names"));
      assert.deepEqual(request.toolChoice, { type: "function", function: { name: "generate_names" } });
      assert.match(JSON.stringify(request.messages[0]), /generate_names/);
      yield { type: "text", content: "ModelInventedName" };
      yield { type: "tool_call_end", content: "", toolCall: { id: "names", type: "function", function: { name: "generate_names", arguments: JSON.stringify(args) } } };
      yield { type: "done", content: "", stopReason: "tool_use" };
    },
  };
  const { stream, run, before, after } = await runNamingRequest("Give me 5 Persian-inspired feminine names", provider);
  assert.equal(calls, 1);
  assert.equal(run.status, "completed");
  assert.match(stream, /"name":"generate_names","status":"success"/);
  assert.doesNotMatch(stream, /ModelInventedName/);
  assert.doesNotMatch(JSON.stringify(run.committedTurns), /ModelInventedName/);
  const names = executeGenerateNames(args, []).names;
  assert.equal(run.textContent, names.map((name, index) => `${index + 1}. ${name}`).join("\n"));
  assert.deepEqual(after, before);
});

test("a provider ignoring the required tool cannot return invented names", async () => {
  const provider: LLMProvider = {
    listModels: async () => [],
    async *generateStream() {
      yield { type: "text", content: "InventedNameInstead" };
      yield { type: "done", content: "", stopReason: "end_turn" };
    },
  };
  const { stream, run, before, after } = await runNamingRequest("Suggest some character names", provider);
  assert.equal(run.status, "error");
  assert.match(stream, /NAME_GENERATOR_REQUIRED/);
  assert.doesNotMatch(stream, /InventedNameInstead/);
  assert.deepEqual(after, before);
});

test("card-wide name reservations survive new runs, handle concurrent calls and replay without duplicates", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("The registry must not call external services"); });
  const provider: LLMProvider = { listModels: async () => [], async *generateStream() {
    yield { type: "tool_call_end", content: "", toolCall: { id: "first-batch", type: "function", function: { name: "generate_names", arguments: JSON.stringify({ style: "nordic", count: 5, seed: "registry" }) } } };
    yield { type: "done", content: "", stopReason: "tool_use" };
  } };
  const { run, before } = await runNamingRequest("Give me 5 Nordic names", provider);
  const input = { style: "nordic", count: 5, seed: "registry" };
  const initial = await executeStudioGenerateNames({ worldId: run.worldId, userId: run.userId, runId: run.id, toolCallId: "first-batch", input, world: before });
  assert.equal(run.textContent, initial.names.map((name, index) => `${index + 1}. ${name}`).join("\n"));
  const nextRunId = crypto.randomUUID();
  await db.insert(agentRuns).values({ id: nextRunId, worldId: run.worldId, userId: run.userId, model: "names-test", status: "running" });
  const requests = ["second-batch", "third-batch"].map(toolCallId => executeStudioGenerateNames({ worldId: run.worldId, userId: run.userId, runId: nextRunId, toolCallId, input, world: before }));
  const subsequent = await Promise.all(requests);
  const allNames = [...initial.names, ...subsequent.flatMap(batch => batch.names)];
  assert.equal(new Set(allNames).size, 15);
  const repeat = await executeStudioGenerateNames({ worldId: run.worldId, userId: run.userId, runId: nextRunId, toolCallId: "second-batch", input, world: before });
  assert.deepEqual(repeat, subsequent[0]);
  await assert.rejects(executeStudioGenerateNames({ worldId: run.worldId, userId: "another-account", runId: nextRunId, toolCallId: "not-owned", input, world: before }), /owned card/);
});

test("a mixed creation request cannot replace generated character names with invented names", async () => {
  let calls = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    calls++;
    if (calls === 1) {
      yield { type: "tool_call_end", content: "", toolCall: { id: "pool", type: "function", function: { name: "generate_names", arguments: JSON.stringify({ style: "finnic", count: 2, seed: "creation" }) } } };
    } else if (calls === 2) {
      assert.equal(request.toolChoice, "auto");
      yield { type: "tool_call_end", content: "", toolCall: { id: "invented-entry", type: "function", function: { name: "write_entry", arguments: JSON.stringify({ id: "new-character", role: "character", name: "UngeneratedCharacter", content: "A traveler." }) } } };
    } else {
      const failure = request.messages.find(message => message.role === "tool" && message.tool_call_id === "invented-entry");
      assert.match(String(failure?.content), /generate_names/);
      yield { type: "text", content: "The invalid name was rejected." };
    }
    yield { type: "done", content: "", stopReason: calls < 3 ? "tool_use" : "end_turn" };
  } };
  const { run, before, after } = await runNamingRequest("Create two characters and generate their names", provider);
  assert.equal(calls, 3);
  assert.equal(run.status, "completed");
  assert.deepEqual(after, before);
});

test("an invented literal surname cannot bypass the Studio generator requirement", async () => {
  let calls = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    calls++;
    if (calls === 1) {
      yield { type: "tool_call_end", content: "", toolCall: { id: "bypass", type: "function", function: { name: "generate_names", arguments: JSON.stringify({ format: "surname", surname: "InventedSurname", count: 1 }) } } };
    } else {
      const failure = request.messages.find(message => message.role === "tool" && message.tool_call_id === "bypass");
      assert.match(String(failure?.content), /creator|supplied/i);
      yield { type: "tool_call_end", content: "", toolCall: { id: "real-names", type: "function", function: { name: "generate_names", arguments: JSON.stringify({ style: "persian", format: "surname", count: 1, seed: "valid" }) } } };
    }
    yield { type: "done", content: "", stopReason: "tool_use" };
  } };
  const { run, stream } = await runNamingRequest("Generate a surname", provider);
  assert.equal(calls, 2);
  assert.equal(run.status, "completed");
  assert.match(stream, /"name":"generate_names","status":"error"/);
  assert.doesNotMatch(String(run.textContent), /InventedSurname/);
});

test("the registry excludes a character saved after the agent's world snapshot", async () => {
  const provider: LLMProvider = { listModels: async () => [], async *generateStream() {
    yield { type: "text", content: "Ready." }; yield { type: "done", content: "", stopReason: "end_turn" };
  } };
  const { run, before } = await runNamingRequest("Say ready", provider);
  const input = { style: "romance", count: 1, seed: "fresh-save" };
  const authoredName = executeGenerateNames(input, []).names[0]!;
  const latest = { ...before, entries: [{ id: "new-save", name: authoredName, role: "character", content: "Saved during the request." }] };
  await db.update(worlds).set({ schema: latest as unknown as Record<string, unknown> }).where(eq(worlds.id, run.worldId));
  const generated = await executeStudioGenerateNames({ worldId: run.worldId, userId: run.userId, runId: run.id, toolCallId: "after-save", input, world: before });
  assert.ok(!generated.names.includes(authoredName));
});
