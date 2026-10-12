import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import {
  user,
  worlds,
  playSessions,
  messages,
  creditWallets,
  modelPrices,
} from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import { normalizeGameState } from "../lib/game-state.js";
import { __setInstalledLookupForTests } from "../lib/extension-hooks.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";
import { getMemoryRuntime, closeMemoryRuntime } from "../memory/runtime.js";
import { ensureProfileSchema, ensureIdentity } from "../memory/schema.js";
import { createMemoryRepositories } from "../memory/repositories/index.js";
import { saveSessionSnapshot } from "../memory/snapshots.js";
import {
  loadStoryhavenTurnContext,
  stopMemoryWorker,
} from "../memory/yumina-adapter.js";
import type { AppEnv } from "../lib/types.js";
import type { GenerateParams } from "../lib/llm/types.js";
test("chat routes use historical StoryHaven recall, include compacted raw history and notes, and fence obsolete replies", async (t) => {
  await ensureStoryhavenMemoryTables();
  const prior = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(async () => {
    env.YUMINA_OPENROUTER_KEY = prior;
    __setInstalledLookupForTests(null);
    await stopMemoryWorker();
    await closeMemoryRuntime();
  });
  registerSessionMemoryExtension();
  __setInstalledLookupForTests(
    async () => new Set([SESSION_MEMORY_EXTENSION_KEY]),
  );
  const model = "google/gemini-2.5-flash",
    vector = [1, 0, 0],
    embeddingInputs: string[] = [];
  await db
    .insert(modelPrices)
    .values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/embeddings")) {
        embeddingInputs.push(JSON.parse(String(init?.body)).input);
        return Response.json({ data: [{ index: 0, embedding: vector }] });
      }
      return Response.json({
        data: [
          {
            id: model,
            context_length: 1048576,
            architecture: { input_modalities: ["text"] },
          },
        ],
      });
    },
  );
  const uid = crypto.randomUUID(),
    wid = crypto.randomUUID();
  await db.insert(user).values({
    id: uid,
    name: "Player",
    email: `${uid}@test.local`,
    preferences: { preferredProvider: "official" },
  });
  await db.insert(creditWallets).values({
    userId: uid,
    plan: "internal",
    balance: 100,
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 86400000),
  });
  const world = migrateWorldDefinition({
    id: wid,
    version: "19.0.0",
    name: "Mira",
    description: "",
    author: "test",
    entries: [
      {id:'visible',name:'Gate lore',role:'lore',content:'AUTHOR BASE LORE',alwaysSend:true,memory:{}},
      {id:'hidden',name:'Hidden lore',role:'lore',content:'UNREVEALED AUTHOR SECRET',alwaysSend:true,memory:{hidden:true}},
      {id:'custom-private',name:'Custom hidden lore',role:'custom',content:'CUSTOM PRIVATE SECRET',alwaysSend:true,memory:{hidden:true}},
      {id:'ordinary',name:'Custom instructions',role:'custom',content:'UNANNOTATED CUSTOM INSTRUCTION',alwaysSend:true},
    ],
    variables: [
      {
        id: "progress",
        name: "progress",
        type: "number",
        defaultValue: 10,
        aiWritable: true,
      },
    ],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "Player" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({
    id: wid,
    creatorId: uid,
    name: world.name,
    status: "draft",
    schema: world as unknown as Record<string, unknown>,
  });
  const liveState = normalizeGameState(world, {
    turnCount: 4,
    variables: { progress: 100 },
    metadata: { lastAssistantResponse: "LIVE FUTURE RESPONSE" },
  });
  const [session] = await db
    .insert(playSessions)
    .values({
      userId: uid,
      worldId: wid,
      state: liveState as unknown as Record<string, unknown>,
      summary: "FUTURE LEGACY SUMMARY",
      summaryIncluded: true,
      summaryceptionIncluded: false,
      sessionMemory: { text: "FUTURE LEGACY MEMORY" },
      sessionMemoryPinned: "Always respect the player standing note.",
    })
    .returning();
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET backend='storyhaven' WHERE session_id=${session!.id}`,
  );
  const seeds = Array.from({ length: 4 }, (_, i) => [
    {
      id: `${uid}:u${i}`,
      sessionId: session!.id,
      role: "user" as const,
      content: i === 3 ? "FUTURE RAW CHAT" : `Earlier question ${i}`,
      compacted: true,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i === 3 ? 5 : i * 2)),
    },
    {
      id: `${uid}:a${i}`,
      sessionId: session!.id,
      role: "assistant" as const,
      content: `Earlier answer ${i}`,
      compacted: true,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i * 2 + 1)),
    },
  ]).flat();
  await db.insert(messages).values(seeds);
  for (let i = 0; i < 4; i++)
    await db
      .update(messages)
      .set({
        stateSnapshot: normalizeGameState(world, {
          turnCount: i + 1,
          variables: { progress: (i + 1) * 10 },
          metadata: { lastAssistantResponse: `Earlier answer ${i}` },
        }) as unknown as Record<string, unknown>,
      })
      .where(eq(messages.id, `${uid}:a${i}`));
  const runtime = await getMemoryRuntime();
  const profile = await runtime.profiles.create(uid, {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "fixture",
    dimensions: 3,
  });
  await ensureProfileSchema(runtime.database, profile);
  await runtime.profiles.setStatus(uid, profile.id, "ready");
  await runtime.profiles.activate(uid, profile.id, profile.revision);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: uid,
    sessionId: session!.id,
    charId: wid,
  };
  await ensureIdentity(runtime.database, scope);
  const repos = createMemoryRepositories(runtime.database, scope, runtime.key);
  await repos.facts.recordBatch("old-batch", 0, 1, 1);
  const old = await repos.facts.insert(
    {
      text: "The old path remains closed.",
      fact_type: "state",
      participants: [],
      importance: 4,
      valence: 0,
      turn: 1,
      batch_id: "old-batch",
    },
    vector,
    true,
  );
  await repos.facts.setCursor(1);
  await repos.lore.upsert({id:`${wid}:visible`,name:'Gate lore',content:'AUTHOR BASE LORE',always:true});
  await repos.lore.upsert({id:`${wid}:hidden`,name:'Hidden lore',content:'UNREVEALED AUTHOR SECRET',always:true,hidden:true});
  await repos.lore.upsert({id:`${wid}:custom-private`,name:'Custom hidden lore',content:'CUSTOM PRIVATE SECRET',always:true,hidden:true});
  const source = await loadStoryhavenTurnContext({
    ownerUserId: uid,
    actingUserId: uid,
    sessionId: session!.id,
  });
  const provenance = { worldHash: source.worldHash, group: false };
  await saveSessionSnapshot(
    runtime.database,
    profile,
    session!.id,
    1,
    source.messages,
    runtime.key,
    provenance,
  );
  await repos.facts.recordBatch("future-batch", 1, 2, 2);
  const future = await repos.facts.supersede(
    old,
    {
      text: "The future gate opened.",
      fact_type: "state",
      participants: [],
      importance: 4,
      valence: 0,
      turn: 2,
      batch_id: "future-batch",
    },
    vector,
    2,
  );
  await repos.facts.setPinned(future, true);
  await repos.lore.setOverride(`${wid}:visible`,'OVERRIDDEN ACTIVE LORE',future,'future-batch');
  await repos.facts.setCursor(2);
  await saveSessionSnapshot(
    runtime.database,
    profile,
    session!.id,
    2,
    source.messages,
    runtime.key,
    provenance,
  );
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: uid } as AppEnv["Variables"]["user"]);
    await next();
  });
  for (const pattern of [
    "/sessions/:sessionId/messages",
    "/sessions/:sessionId/continue",
    "/messages/:id/regenerate",
  ])
    for (const route of messageRoutes.routes.filter(
      (r) => r.method === "POST" && r.path === pattern,
    ))
      app.post(pattern, route.handler);
  const prompts: Array<Array<{ role: string; content: unknown }>> = [];
  let duringStream: (() => Promise<void>) | undefined;
  t.mock.method(
    OpenRouterProvider.prototype,
    "generateStream",
    async function* (request: GenerateParams) {
      prompts.push(request.messages);
      yield {
        type: "text" as const,
        content: `A new route outcome ${prompts.length}. [progress: add 2]`,
      };
      await duringStream?.();
      yield {
        type: "done" as const,
        content: "",
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
  );
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const done = async (response: Response) => {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /event: done/);
    assert.doesNotMatch(text, /event: error/);
  };
  await done(await post(`/messages/${uid}:a2/regenerate`, { model }));
  const historical = JSON.stringify(prompts[0]);
  assert.match(historical, /The old path remains closed/);
  assert.doesNotMatch(
    historical,
    /The future gate opened|FUTURE RAW CHAT|FUTURE LEGACY/,
  );
  assert.match(historical, /standing note/);
  assert.match(historical, /Earlier question 0/);
  assert.deepEqual(
    (
      await db
        .select()
        .from(playSessions)
        .where(eq(playSessions.id, session!.id))
    )[0]!.state,
    session!.state,
    "historical regeneration preserves the live future state and latest response",
  );
  const [historicalReply] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, `${uid}:a2`));
  assert.equal(
    (historicalReply!.stateSnapshot!.variables as Record<string, unknown>)
      .progress,
    22,
    "earlier reply uses the prior selected assistant baseline",
  );
  await done(
    await post(`/sessions/${session!.id}/messages`, {
      model,
      content: "Use this raw user query.",
    }),
  );
  assert.match(JSON.stringify(prompts[1]), /The future gate opened/);
  assert.match(JSON.stringify(prompts[1]),/OVERRIDDEN ACTIVE LORE/);assert.doesNotMatch(JSON.stringify(prompts[1]),/AUTHOR BASE LORE/);
  assert.ok(
    embeddingInputs.some((value) => value.includes("Use this raw user query.")),
  );
  await done(await post(`/sessions/${session!.id}/continue`, { model }));
  await done(
    await post(`/sessions/${session!.id}/messages`, { model, continue: true }),
  );
  for (const prompt of prompts) {
    const text = JSON.stringify(prompt);
    assert.match(text, /standing note/);
    assert.doesNotMatch(text, /FUTURE LEGACY/);
    assert.doesNotMatch(text,/UNREVEALED AUTHOR SECRET|CUSTOM PRIVATE SECRET/);assert.match(text,/UNANNOTATED CUSTOM INSTRUCTION/);
  }
  const before = (
    await db.select().from(messages).where(eq(messages.sessionId, session!.id))
  ).filter((row) => row.role === "assistant").length;
  duringStream = async () => {
    await db
      .update(messages)
      .set({ content: "Earlier selected source was edited." })
      .where(eq(messages.id, `${uid}:u0`));
  };
  const rejected = await post(`/sessions/${session!.id}/messages`, {
    model,
    content: "Try another action.",
  });
  const stream = await rejected.text();
  assert.match(stream, /TURN_CHANGED/);
  assert.match(stream, /event: error/);
  assert.equal(
    (
      await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, session!.id))
    ).filter((row) => row.role === "assistant").length,
    before,
  );
});
