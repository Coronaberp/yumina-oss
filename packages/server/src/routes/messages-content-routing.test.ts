import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { migrateWorldDefinition, ResponseParser, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, apiKeys, worlds, playSessions, messages, usageLogs, userPersonas } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { completionRoutes } from "./completions.js";
import { encryptApiKey } from "../lib/crypto.js";
import { kevContentClassifier } from "../lib/kev-content-classifier.js";
import { createPendingContentFlags } from "../lib/content-flag-policy.js";
import { guardTurnOutput } from "../extensions/state-update-guard/validate.js";
import { resolveGuardModel } from "../extensions/state-update-guard/model.js";
import { normalizeGameState } from "../lib/game-state.js";
import type { AppEnv } from "../lib/types.js";

test("Story HTTP routes send unsafe whole-message context only to the exact fallback", async t => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), sfw = crypto.randomUUID(), nsfw = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Content route", email: `${uid}@test.local`, preferences: { preferredProvider: "private", activeApiKeyId: sfw, nsfwApiKeyId: nsfw } });
  const key = encryptApiKey("routing-route-fixture-key");
  await db.insert(apiKeys).values([
    { id: sfw, userId: uid, provider: "custom", baseUrl: "https://story.example/v1", metadata: { defaultModel: "story-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
    { id: nsfw, userId: uid, provider: "custom", baseUrl: "https://fallback.example/v1", metadata: { defaultModel: "fallback-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
  ]);
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Routing world", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 1024, maxContext: 16000, playerName: "Player" } } as unknown as WorldDefinition);
  // Use an actual all-ages preset for the SFW transport proof. The default
  // Fiction Mode explicitly asks for adult content and must route to NSFW.
  world.entries = world.entries.map(entry => entry.presetId === "fiction-mode" ? { ...entry, content: "Run an all-ages town simulation with ordinary conversation and quiet exploration." } : entry);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  const patterns = ["/sessions/:sessionId/messages", "/messages/:id/regenerate", "/sessions/:sessionId/continue", "/messages/:id/generate-choices", "/sessions/:sessionId/ending"];
  for (const route of messageRoutes.routes.filter(r => r.method === "POST" && patterns.includes(r.path))) app.post(route.path, route.handler);
  for (const route of completionRoutes.routes.filter(r => r.method === "POST" && r.path === "/sessions/:sessionId/completions")) app.post(route.path, route.handler);
  let classifierFails = false;
  t.mock.method(kevContentClassifier, "classify", async (role: "user" | "assistant" | "system", content: string, choices: readonly string[] = []) => {
    if (classifierFails) throw new Error("classifier fixture unavailable");
    const unsafe = content.includes("UNSAFE") || choices.some(choice => choice.includes("UNSAFE"));
    return { ...createPendingContentFlags(role, content, choices), status: "complete" as const, label: unsafe ? "nsfw" as const : "sfw" as const, routingSafe: !unsafe, nsfwProbability: unsafe ? .9 : .01, sfwProbability: unsafe ? .1 : .99, completedAt: new Date().toISOString(), device: "cpu" as const, model: "fixture-kev" };
  });
  let output = "A quiet scene continues.";
  const calls: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const done = async (response: Response) => { const body = await response.text(); assert.equal(response.status, 200, body); assert.match(body, /event: done/); assert.doesNotMatch(body, /event: error/); };
  const history = () => db.select().from(messages).where(eq(messages.sessionId, session!.id)).orderBy(asc(messages.createdAt), asc(messages.id));
  const onlyFallback = (start: number) => {
    assert.ok(calls.length > start);
    assert.ok(calls.slice(start).every(call => call.url === "https://fallback.example/v1/chat/completions"), JSON.stringify(calls.slice(start)));
    assert.ok(calls.slice(start).every(call => call.body.model === "fallback-model"));
  };
  await t.test("send, regenerate and continue purge player lines before SSE publication and history persistence", async () => {
    const [fresh] = await db.insert(playSessions).values({ userId: uid, worldId, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning();
    const previous = output;
    output = '[SPEAKER:Guide:normal] "The gate is open."\n*{{user}} raises a hand.*\n[SPEAKER:{{user}}:normal] "I will go."\n[SPEAKER:Narrator:normal] *The bell rings.*\n[CHOICES:["Ask the guide","Walk to the gate"]]';
    try {
      const send = await post(`/sessions/${fresh!.id}/messages`, { content: "Wait by the gate.", model: "custom/story-model", overrides: { streaming: true } });
      const body = await send.text();
      assert.equal(send.status, 200, body);
      assert.match(body, /event: done/);
      assert.doesNotMatch(body, /event: (?:text|error)|raises a hand|I will go/);
      let rows = await db.select().from(messages).where(eq(messages.sessionId, fresh!.id));
      const reply = rows.find(row => row.role === "assistant")!;
      for (const path of [`/messages/${reply.id}/regenerate`, `/sessions/${fresh!.id}/continue`]) {
        const result = await post(path, { model: "custom/story-model", overrides: { streaming: true } });
        const events = await result.text();
        assert.equal(result.status, 200, events);
        assert.match(events, /event: done/);
        assert.doesNotMatch(events, /event: (?:text|error)|raises a hand|I will go/);
      }
      rows = await db.select().from(messages).where(eq(messages.sessionId, fresh!.id));
      for (const row of rows.filter(row => row.role === "assistant")) {
        assert.doesNotMatch(JSON.stringify(row), /raises a hand|I will go/);
        assert.match(row.content, /The gate is open/);
        assert.deepEqual(row.swipes?.[row.activeSwipeIndex ?? 0]?.choices, ["Ask the guide", "Walk to the gate"]);
      }
      // The submitted player action remains their own text.
      assert.equal(rows.find(row => row.role === "user")?.content, "Wait by the gate.");
    } finally {
      output = previous;
      await db.delete(playSessions).where(eq(playSessions.id, fresh!.id));
    }
  });
  await t.test("model identity uses the token while saved generation state retains the UI persona", async () => {
    const [persona] = await db.insert(userPersonas).values({ userId: uid, name: "PRIVATE_ROLEPLAY_NAME", appearance: "Blue academy coat", backstory: "A scholar from the mountains", isActive: true }).returning();
    const [fresh] = await db.insert(playSessions).values({ userId: uid, worldId, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning();
    const start = calls.length;
    await done(await post(`/sessions/${fresh!.id}/messages`, { content: "Wait by the gate.", model: "custom/story-model" }));
    assert.ok(!JSON.stringify(calls.slice(start)).includes("PRIVATE_ROLEPLAY_NAME"));
    assert.ok(JSON.stringify(calls.slice(start)).includes("{{user}}"));
    assert.ok(JSON.stringify(calls.slice(start)).includes("Blue academy coat"));
    assert.ok(JSON.stringify(calls.slice(start)).includes("A scholar from the mountains"));
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, fresh!.id));
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaName, "PRIVATE_ROLEPLAY_NAME");
    const rows = await db.select().from(messages).where(eq(messages.sessionId, fresh!.id));
    const reply = rows.find(row => row.role === "assistant")!;
    assert.equal((reply.swipes?.[0]?.generationState?.metadata as Record<string, unknown>).personaName, "PRIVATE_ROLEPLAY_NAME");
    await db.delete(playSessions).where(eq(playSessions.id, fresh!.id));
    await db.delete(userPersonas).where(eq(userPersonas.id, persona!.id));
  });
  await t.test("side-call prompts anonymize creator personas that have no personal-profile row", async () => {
    const [fresh] = await db.insert(playSessions).values({ userId: uid, worldId, personaLocked: true, sessionPersona: { persona: { name: "PRIVATE_CREATOR_PRESET" }, selection: { kind: "preset", id: "preset" } }, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning();
    const start = calls.length;
    await done(await post(`/sessions/${fresh!.id}/completions`, { model: "custom/story-model", messages: [{ role: "user", content: "Describe what PRIVATE_CREATOR_PRESET can see." }] }));
    assert.ok(calls.length > start);
    assert.ok(!JSON.stringify(calls.slice(start)).includes("PRIVATE_CREATOR_PRESET"));
    assert.ok(JSON.stringify(calls.slice(start)).includes("{{user}}"));
    await db.delete(playSessions).where(eq(playSessions.id, fresh!.id));
  });
  await t.test("safe send uses selected Story provider and unsafe next turn routes before sending", async () => {
    await done(await post(`/sessions/${session!.id}/messages`, { content: "A harmless greeting.", model: "custom/story-model" }));
    assert.equal(calls.at(-1)?.url, "https://story.example/v1/chat/completions");
    const start = calls.length;
    await done(await post(`/sessions/${session!.id}/messages`, { content: "UNSAFE complete first paragraph.\n\nSecond paragraph gives context.", model: "custom/story-model" }));
    onlyFallback(start);
    const reply = (await history()).at(-1)!;
    assert.equal(reply.model, "custom/fallback-model");
    assert.ok((await db.select().from(usageLogs).where(eq(usageLogs.userId, uid))).some(row => row.model === "custom/fallback-model"));
  });
  await t.test("regenerate and continue route unsafe earlier human history before generation", async () => {
    const reply = (await history()).at(-1)!;
    for (const [path, body] of [[`/messages/${reply.id}/regenerate`, { model: "custom/story-model" }], [`/sessions/${session!.id}/continue`, { model: "custom/story-model" }]] as const) {
      const start = calls.length;
      await done(await post(path, body));
      onlyFallback(start);
    }
  });
  await t.test("continue classifies offered choices with the complete included response", async () => {
    const [fresh] = await db.insert(playSessions).values({ userId: uid, worldId, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning();
    await db.insert(messages).values({ sessionId: fresh!.id, role: "user", content: "A safe greeting.", status: "complete" });
    const content = "A safe complete narrative.";
    await db.insert(messages).values({ sessionId: fresh!.id, role: "assistant", content, status: "complete", model: "custom/story-model", activeSwipeIndex: 0,
      swipes: [{ content, rawContent: content, choices: ["UNSAFE offered choice"], model: "custom/story-model", createdAt: new Date().toISOString() }] });
    const start = calls.length;
    await done(await post(`/sessions/${fresh!.id}/continue`, { model: "custom/story-model" }));
    onlyFallback(start);
  });
  await t.test("manual choices use the full model response to route their excerpted prompt", async () => {
    const reply = (await history()).at(-1)!;
    const content = "UNSAFE original reply " + "ordinary scene ".repeat(2500);
    const swipes = [{ content, rawContent: content, model: "custom/story-model", choices: [], createdAt: new Date().toISOString() }];
    await db.update(messages).set({ content, swipes, activeSwipeIndex: 0, status: "complete" }).where(eq(messages.id, reply.id));
    output = '{"choices":["Inspect the room","Speak to the guide"]}';
    const start = calls.length;
    const response = await post(`/messages/${reply.id}/generate-choices`, { activeSwipeIndex: 0 });
    assert.equal(response.status, 200, await response.text());
    onlyFallback(start);
  });
  await t.test("side completions route system context and classifier errors before any Story call", async () => {
    output = "Side response.";
    for (const content of ["UNSAFE side system context", "Fresh classifier failure side context"]) {
      classifierFails = !content.includes("UNSAFE");
      const start = calls.length;
      await done(await post(`/sessions/${session!.id}/completions`, { model: "custom/story-model", messages: [{ role: "system", content }, { role: "user", content: "Respond" }] }));
      onlyFallback(start);
    }
    classifierFails = false;
  });
  await t.test("a separately resolved correction preflights a newly unsafe generated draft", async () => {
    const correctionWorld = { ...world, variables: [{ id: "energy", name: "Energy", type: "number" as const, defaultValue: 10 }] };
    const raw = "UNSAFE newly generated draft.";
    output = JSON.stringify({ narrative: "", status: "none", stateChanges: [], review: [{ variableId: "energy", reason: "No exertion occurs." }] });
    const correction = await resolveGuardModel(uid, "private::custom/story-model", false);
    assert.equal(correction.model, "custom/story-model");
    const start = calls.length;
    const logged: string[] = [];
    const result = await guardTurnOutput({ world: correctionWorld, state: normalizeGameState(correctionWorld, {}), raw, parsed: new ResponseParser().parse(raw),
      provider: correction.provider, model: correction.model, maxContext: correction.maxContext, resolveCorrection: async () => correction,
      signal: new AbortController().signal, history: [], mayCorrect: async () => true, progress: async () => {},
      audit: { version: 1, attemptId: "routing-correction", path: "send", outcome: "validating", diagnostics: [], parsedCount: 0, repaired: false, correctionCount: 0, model: correction.model, apiKeyTier: "byok", startedAt: new Date().toISOString(), baselineFingerprint: "test", usageLogIds: [] },
      recordUsage: async (_usage, model) => { logged.push(model); return "fixture-usage"; } });
    onlyFallback(start);
    assert.equal(result.audit?.correctionModel, "custom/fallback-model");
    assert.equal(result.audit?.correctionApiKeyTier, "byok");
    assert.deepEqual(logged, ["custom/fallback-model"]);
    const nextStart = calls.length;
    const safeRaw = "A safe frozen draft.";
    await guardTurnOutput({ world: correctionWorld, state: normalizeGameState(correctionWorld, {}), raw: safeRaw, parsed: new ResponseParser().parse(safeRaw),
      provider: correction.provider, model: correction.model, maxContext: correction.maxContext, resolveCorrection: async () => correction,
      signal: new AbortController().signal, history: [{ role: "assistant", content: "Safe full narrative", choices: ["UNSAFE offered choice"] }], mayCorrect: async () => true, progress: async () => {},
      audit: { version: 1, attemptId: "routing-choice-correction", path: "continue", outcome: "validating", diagnostics: [], parsedCount: 0, repaired: false, correctionCount: 0, model: correction.model, apiKeyTier: "byok", startedAt: new Date().toISOString(), baselineFingerprint: "test", usageLogIds: [] },
      recordUsage: async (_usage, model) => { assert.equal(model, "custom/fallback-model"); return "fixture-choice-usage"; } });
    onlyFallback(nextStart);
    assert.match(calls.at(-1)?.body.messages[1].content, /UNSAFE offered choice/);
  });
  await t.test("AI ending routes complete scene content and records the fallback model", async () => {
    const reply = (await history()).at(-1)!;
    const state = { worldId, variables: {}, turnCount: 3, metadata: {}, story: { status: "ending-ready", ending: { id: "end", name: "End", outcome: "The door closes", mode: "ai", prose: "", guidance: "A quiet conclusion", selectedTurn: 3, operationId: "route-ending" } } };
    await db.update(playSessions).set({ state }).where(eq(playSessions.id, session!.id));
    output = "The door closes quietly.";
    const start = calls.length;
    const response = await post(`/sessions/${session!.id}/ending`, { operationId: "route-ending", messageId: reply.id, activeSwipeIndex: 0, model: "custom/story-model" });
    assert.equal(response.status, 200, await response.text());
    onlyFallback(start);
  });
});
