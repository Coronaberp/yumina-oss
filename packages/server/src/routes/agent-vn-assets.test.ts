import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { VN_BACKGROUND_TEMPLATE, migrateWorldDefinition, readVnAssetMap, readVnOpeningScenes, worldEntrySchema, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, userAssets, userDanbooruSettings, userImageGenerationSettings, generationJobs } from "../db/schema.js";
import { danbooruService } from "../lib/image-sources/danbooru-service.js";
import { imageGenerationService } from "../lib/image-generation/default.js";
import { auth } from "../lib/auth.js";
import { env } from "../lib/env.js";
import { waitForConfiguredImage } from "../lib/studio-tools/configured-image-proposal.js";
import { configuredImageJobs } from "../lib/configured-image-jobs.js";
import { normalizeImageProposal } from "../lib/studio-tools/image-proposal.js";
import type { GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { agentRoutes, streamAgentLoop } from "./agent.js";

test("Danbooru credentials are encrypted, owner scoped, and excluded from public agent config", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Image settings test", email: `${uid}@test.local` });
  try {
    const config = await danbooruService.updateConfig(uid, { enabled: true, username: "test_creator", apiKey: "test-secret-never-return" });
    assert.deepEqual(config, { enabled: true, username: "test_creator", hasKey: true, configured: true });
    assert.ok(!JSON.stringify(config).includes("test-secret-never-return"));
    const [stored] = await db.select().from(userDanbooruSettings).where(eq(userDanbooruSettings.userId, uid));
    assert.ok(stored?.encryptedKey);
    assert.notEqual(stored.encryptedKey, "test-secret-never-return");
    assert.ok(stored.keyIv && stored.keyTag);
    assert.equal((await danbooruService.getConfig(crypto.randomUUID())).hasKey, false);
    assert.equal((await danbooruService.updateConfig(uid, { enabled: false, username: "test_creator" })).hasKey, true);
    await danbooruService.clearConfig(uid);
    assert.equal((await danbooruService.getConfig(uid)).enabled, false);
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("streaming creator agent reads VN help, imports artwork, writes assignments and rejects foreign assets", async t => {
  const uid = crypto.randomUUID(), otherId = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID();
  const imageId = crypto.randomUUID(), foreignId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "VN agent integration", description: "", author: "test",
    entries: [worldEntrySchema.parse({ id: "opening-one", name: "First opening", role: "greeting", content: "Hello", enabled: true, section: "chat-history" })],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    rootComponent: { id: "root", name: "VN", interfaceId: "vn", entryFile: "index.tsx", updatedAt: "before", files: {
      "index.tsx": "export default function World(){return <Chat />;}", "sprites.ts": "export const sprites = {};", "scenes.ts": VN_BACKGROUND_TEMPLATE,
    } }, settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(user).values([{ id: uid, name: "VN test", email: `${uid}@test.local` }, { id: otherId, name: "Other", email: `${otherId}@test.local` }]);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "vn-test", status: "running", context: { preserveTraceSibling: true } });
  await db.insert(userAssets).values({ id: foreignId, userId: otherId, type: "image", filename: "foreign.png", url: "fixture/foreign.png" });
  let imports = 0;
  // An injected source result proves import dispatch and owned ref binding, with no provider requests.
  t.mock.method(danbooruService, "import", async (owner: string, postId: number) => {
    assert.equal(owner, uid); assert.equal(postId, 7); imports++;
    await db.insert(userAssets).values({ id: imageId, userId: uid, type: "image", filename: "danbooru-7.png", url: "fixture/danbooru.png" });
    return { id: imageId, ref: `@asset:${imageId}`, filename: "danbooru-7.png", source: { postId: 7, pageUrl: "https://danbooru.donmai.us/posts/7" } };
  });
  let iterations = 0;
  const resultFor = (request: GenerateParams, id: string) => {
    const result = request.messages.find(message => message.role === "tool" && message.tool_call_id === id);
    assert.ok(result, `Missing result ${id}`);
    return JSON.parse(String(result.content));
  };
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    iterations++;
    const call = (id: string, name: string, args: unknown) => ({ type: "tool_call_end" as const, content: "", toolCall: { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } } });
    if (iterations === 1) {
      yield call("help", "list_vn_assets", { kind: "backgrounds" });
      yield call("sources", "get_image_sources", {});
      yield call("import", "import_danbooru_image", { postId: 7 });
    } else if (iterations === 2) {
      assert.equal(resultFor(request, "help").openings[0].id, "opening-one");
      assert.match(resultFor(request, "help").help, /Settings/);
      assert.equal(resultFor(request, "sources").danbooru.enabled, false);
      assert.equal(resultFor(request, "sources").generation.available, false);
      assert.equal(resultFor(request, "import").ref, `@asset:${imageId}`);
      yield call("sprite", "edit_vn_assets", { kind: "sprites", action: "assign", name: "Alice", variant: "happy", assetRef: `@asset:${imageId}` });
      yield call("background", "edit_vn_assets", { kind: "backgrounds", action: "assign", openingId: "opening-one", name: "garden", assetRef: `@asset:${imageId}` });
      yield call("foreign", "edit_vn_assets", { kind: "sprites", action: "assign", name: "Bob", assetRef: `@asset:${foreignId}` });
      yield call("disabled-search", "search_danbooru_images", { tags: "scenery" });
    } else {
      assert.equal(iterations, 3);
      assert.equal(resultFor(request, "sprite").status, "OK");
      assert.equal(resultFor(request, "background").status, "OK");
      assert.match(resultFor(request, "foreign").error, /your asset library/);
      assert.match(resultFor(request, "disabled-search").error, /Enable Danbooru in Settings/);
      yield { type: "text", content: "Assigned the imported sprite and opening background." };
    }
    yield { type: "done", content: "", stopReason: iterations < 3 ? "tool_use" : "end_turn" };
  } };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
    messages: [{ role: "user", content: "Import and assign a sprite and opening background." }],
    model: "vn-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS }));
  try {
    const response = await app.request("/test");
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(stream, /event: error/);
    assert.equal(imports, 1);
    const traceEvents = [...stream.matchAll(/event: tool_trace\ndata: (.*)/g)].map(match => JSON.parse(match[1]!));
    assert.ok(traceEvents.length > 0);
    const trace = traceEvents.at(-1)!.items;
    assert.equal(trace.find((item: { id: string }) => item.id === "sprite").status, "done");
    assert.equal(trace.find((item: { id: string }) => item.id === "foreign").status, "failed");
    assert.ok(!JSON.stringify(trace).includes("fixture/foreign.png"));
    const saved = (await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!.schema as unknown as WorldDefinition;
    assert.deepEqual(readVnAssetMap(saved.rootComponent!.files["sprites.ts"]!, "sprites"), { Alice: { happy: `@asset:${imageId}` } });
    assert.deepEqual(readVnAssetMap(saved.rootComponent!.files["scenes.ts"]!, "backgrounds"), {});
    assert.deepEqual(readVnOpeningScenes(saved.rootComponent!.files["scenes.ts"]!), { "opening-one": { garden: { day: `@asset:${imageId}` } } });
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.status, "completed");
    const storedTrace = (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.context?.studioToolTrace as Array<{ id: string; status: string }>;
    assert.equal(storedTrace.find(item => item.id === "foreign")!.status, "failed");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.context?.preserveTraceSibling, true);
  } finally {
    await db.delete(user).where(eq(user.id, uid));
    await db.delete(user).where(eq(user.id, otherId));
  }
});


test("generation profiles encrypt separate keys, preserve both configurations and scope the selected default", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Generation profiles", email: `${uid}@test.local` });
  try {
    const workflow = JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } } });
    await imageGenerationService.updateConfig(uid, { provider: "comfyui", enabled: true, baseUrl: "https://comfy.example.com", workflow, apiKey: "comfy-fixture-key", makeActive: true });
    await imageGenerationService.updateConfig(uid, { provider: "forgeneo", enabled: true, baseUrl: "https://forge.example.com", model: "checkpoint.safetensors", apiKey: "neo:fixture-key", makeActive: true });
    const state = await imageGenerationService.getConfig(uid);
    assert.equal(state.activeProvider, "forgeneo");
    assert.equal(state.configs.comfyui.configured, true);
    assert.equal(state.configs.forgeneo.configured, true);
    const stored = await db.select().from(userImageGenerationSettings).where(eq(userImageGenerationSettings.userId, uid));
    assert.equal(stored.length, 2);
    for (const row of stored) { assert.ok(row.keyIv && row.keyTag && row.encryptedKey); assert.doesNotMatch(row.encryptedKey, /fixture-key/); }
    const status = JSON.stringify(await imageGenerationService.getStatus(uid));
    assert.doesNotMatch(status, /fixture-key|127.0.0.1|CLIPTextEncode|https:/);
    assert.equal((await imageGenerationService.getConfig(crypto.randomUUID())).configs.forgeneo.hasKey, false);
    await imageGenerationService.clearConfig(uid, "forgeneo");
    const cleared = await imageGenerationService.getConfig(uid);
    assert.equal(cleared.activeProvider, "forgeneo");
    assert.equal(cleared.configs.forgeneo.configured, false);
    assert.equal(cleared.configs.comfyui.configured, true);
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("the agent queues a configured Forge Neo sprite automatically and continues without awaiting the provider", async t => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Generation confirmation", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Proposal test", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "image-test", status: "running" });
  await imageGenerationService.updateConfig(uid, { provider: "forgeneo", enabled: true, baseUrl: "https://forge.example.com", model: "checkpoint.safetensors", apiKey: "neo:fixture-never-used", makeActive: true });
  let generations = 0;
  t.mock.method(imageGenerationService, "generate", async () => { generations++; throw new Error("Generation belongs to the independent worker"); });
  let turns = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream() {
    if (turns++ > 0) { yield { type: "text", content: "The image is drawing in the background." };yield { type: "done", content: "", stopReason: "end_turn" };return; }
    yield { type: "tool_call_end", content: "", toolCall: { id: "sprite-proposal", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "An isolated smiling silver-haired mage, blue uniform, full figure.", imageKind: "sprite", purpose: "Mage happy expression" }) } } };
    yield { type: "done", content: "", stopReason: "tool_use" };
  } };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world, messages: [{ role: "user", content: "Create a happy mage sprite." }], model: "image-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 2, tools: STUDIO_TOOLS }));
  try {
    const text = await (await app.request("/test")).text();
    assert.doesNotMatch(text, /event: error/);
    assert.match(text, /event: image_proposal/);
    assert.match(text, /"source":"forgeneo"/);
    assert.equal(generations, 0);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal(run!.status, "completed");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.userId, uid));
    assert.equal(job!.status, "queued");
    const proposal = job!.params.proposal as Record<string, unknown>;
    assert.equal(proposal.source, "forgeneo"); assert.equal(proposal.imageKind, "sprite"); assert.equal(proposal.batchSize, 1);
    assert.equal(proposal.model, "checkpoint.safetensors");
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("a legacy saved confirmation returns its stable background job immediately", async t => {
  t.mock.method(configuredImageJobs, "submit", async (options: Parameters<typeof configuredImageJobs.submit>[0]) => {
    assert.equal(options.userId, "creator");assert.equal(options.worldId, "world-one");assert.equal(options.runId, "run-one");
    assert.equal(options.proposal.prompt, "Edited isolated character artwork.");
    return { jobId: "same-job", status: "queued" as const, assetIds: [], refs: [], errorCode: null, elapsed: 0 };
  });
  const call = { id: "call-one", type: "function" as const, function: { name: "generate_image", arguments: "{}" } };
  const proposal = normalizeImageProposal({ source: "forgeneo", imageKind: "sprite", prompt: "Edited isolated character artwork.", model: "checkpoint.safetensors", batchSize: 4 })!;
  assert.equal(proposal.batchSize, 1);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const signal = new AbortController().signal;
  const invoke = () => waitForConfiguredImage({ call, proposal, userId: "creator", runId: "run-one", worldId: "world-one", signal, progress: () => {}, send: async (event, data) => { events.push({ event, data: JSON.parse(data) }); } });
  const messages = await invoke(); await invoke();
  assert.equal(events.filter(item => item.event === "image_result").length, 0);
  assert.ok(events.filter(item => item.event === "image_progress").every(item => item.data.jobId === "same-job"));
  assert.match(JSON.stringify(messages), /same-job/);
  assert.doesNotMatch(JSON.stringify(messages), /refunded|free/);
});

test("image confirmation rejects non-boolean approval without changing the paused run or calling a provider", async t => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Confirmation validation", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Validation", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "image-test", status: "awaiting_approval" });
  t.mock.method(auth.api, "getSession", async () => ({ user: { id: uid }, session: { id: "fixture-session", userId: uid, expiresAt: new Date(Date.now() + 60_000), token: "fixture" } }));
  let generations = 0;
  t.mock.method(imageGenerationService, "generate", async () => { generations++; throw new Error("No provider call expected"); });
  try {
    for (const approved of ["true", "false", 1, null]) {
      const response = await agentRoutes.request(`/${worldId}/agent/generate-image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, approved }) });
      assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, "INVALID_CONFIRMATION");
    }
    const malformed = await agentRoutes.request(`/${worldId}/agent/generate-image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.status, "awaiting_approval");
    assert.equal(generations, 0);
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("asking a question does not trace a combined skipped write as an applied change", async () => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Skipped trace", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Trace QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Trace QA", status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "trace-fixture", status: "running" });
  const provider: LLMProvider = { listModels: async () => [], async *generateStream() {
    for (const [id, name, args] of [["question", "ask_user", { question: "Which scene?" }], ["skipped-write", "write_entry", { name: "Must not be created", content: "Skipped" }]] as const) {
      yield { type: "tool_call_end", content: "", toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } } };
    }
    yield { type: "done", content: "", stopReason: "tool_use" };
  } };
  const app = new Hono();app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
    messages: [{ role: "user", content: "Ask and write" }], model: "trace-fixture", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 2, tools: STUDIO_TOOLS }));
  try {
    const stream = await (await app.request("/test")).text();assert.match(stream, /Not executed/);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));assert.equal(run!.status, "awaiting_user");
    const trace = run!.context!.studioToolTrace as Array<{ id: string; title: string; status: string }>;
    assert.equal(trace.find(item => item.id === "skipped-write")!.title, "Not executed");assert.notEqual(trace.find(item => item.id === "skipped-write")!.status, "done");
    const [saved] = await db.select().from(worlds).where(eq(worlds.id, worldId));assert.equal((saved!.schema.entries as unknown[]).length, 0);
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("one Codex step queues multiple independent images and continues without confirmation", async t => {
  const previousEnabled = env.YUMINA_STUDIO_CODEX_ENABLED, previousEdition = env.YUMINA_EDITION;
  env.YUMINA_STUDIO_CODEX_ENABLED = true;env.YUMINA_EDITION = "local";
  t.after(() => { env.YUMINA_STUDIO_CODEX_ENABLED = previousEnabled;env.YUMINA_EDITION = previousEdition; });
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Parallel proposals", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Fan QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "image-fixture", status: "running" });
  let turns = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    if (turns++ === 0) {
      for (const color of ["red", "blue"]) yield { type: "tool_call_end", content: "", toolCall: { id: color, type: "function", function: { name: "generate_image", arguments: JSON.stringify({ source: "codex", imageKind: "image", prompt: `A safe ${color} circle`, purpose: `${color} circle` }) } } };
      yield { type: "done", content: "", stopReason: "tool_use" };return;
    }
    for (const color of ["red", "blue"]) {
      const result = request.messages.find(message => message.role === "tool" && message.tool_call_id === color);
      assert.ok(result);assert.equal(JSON.parse(String(result.content)).status, "queued");
    }
    yield { type: "text", content: "Both images are drawing independently." };yield { type: "done", content: "", stopReason: "end_turn" };
  } };
  const app = new Hono();app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
    messages: [{ role: "user", content: "Generate two icons in parallel" }], model: "image-fixture", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 3, tools: STUDIO_TOOLS }));
  try {
    const stream = await (await app.request("/test")).text();assert.doesNotMatch(stream, /event: error/);
    assert.equal([...stream.matchAll(/event: image_proposal/g)].length, 2);
    const jobs = await db.select().from(generationJobs).where(eq(generationJobs.userId, uid));assert.equal(jobs.length, 2);assert.notEqual(jobs[0]!.id, jobs[1]!.id);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.status, "completed");
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});
