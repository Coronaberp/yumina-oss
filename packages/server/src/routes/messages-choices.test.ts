import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, modelPrices, creditTransactions, usageLogs, apiKeys } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { messageRoutes } from "./messages.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import { kevContentClassifier } from "../lib/kev-content-classifier.js";
import { createPendingContentFlags } from "../lib/content-flag-policy.js";
import type { AppEnv } from "../lib/types.js";

test("manual choice recovery preserves the scene and rejects invalid, duplicate and stale calls", async t => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const model = "google/gemini-2.5-flash";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: model, context_length: 100000, architecture: { input_modalities: ["text"] } }] }));
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID();
  let actor: string = uid;
  await db.insert(user).values({ id: uid, name: "Choices test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  const [wallet] = await db.insert(creditWallets).values({ userId: uid, plan: "pro", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) }).returning();
  const debits = async () => (await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id))).length;
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Choices test", description: "", author: "test",
    entries: [], variables: [{ id: "wealth", name: "Crowns", type: "number", defaultValue: 100 }, { id: "secret", name: "Private", type: "string", defaultValue: "HIDDEN_STATE_NEVER_INPUT", aiAccess: "none" }], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: { variables: { trust: 7, wealth: 100, secret: "HIDDEN_STATE_NEVER_INPUT" } }, sessionPersona: { persona: { name: "Robin", appearance: "Robin wears a blue coat.", entries: [] }, started: true } }).returning();
  await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "Ask about the cup", createdAt: new Date("2026-10-03T01:00:00Z") });
  const scene = '[SPEAKER:Miveth:normal] "The cup is here."\n*The cup rests on the table.*';
  const swipes = [
    { content: "A different scene", rawContent: "An earlier raw reply", model, createdAt: "2026-10-03T01:00:01Z", choices: [] },
    { content: scene, rawContent: scene, model, createdAt: "2026-10-03T01:00:02Z", choices: [], reasoningContent: "PRIVATE_TRACE_NEVER_INPUT", stateSnapshot: { trust: 7 }, generationState: { trust: 5 }, stateChanges: { trust: 2 }, tokenCount: 800, creditCost: 4 },
  ];
  const [reply] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: scene, swipes, activeSwipeIndex: 1,
    model, stateSnapshot: { trust: 7 }, stateChanges: { trust: 2 }, createdAt: new Date("2026-10-03T01:00:02Z") }).returning();
  const path = `/messages/${reply!.id}/generate-choices`;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes.filter(r => r.path === "/messages/:id/generate-choices")) app.on(route.method, route.path, route.handler);
  // This test covers choice generation and persistence, not classifier
  // availability. Return the same complete CPU audit the configured live
  // profile receives so routing reaches the mocked model request.
  t.mock.method(kevContentClassifier, "classify", async (role: "user" | "assistant" | "system", content: string, choices: readonly string[] = []) => ({
    ...createPendingContentFlags(role, content, choices), status: "complete" as const, label: "sfw" as const, routingSafe: true,
    nsfwProbability: .01, sfwProbability: .99, completedAt: new Date().toISOString(), device: "cpu" as const, model: "fixture-kev",
  }));
  const post = (body: unknown = { activeSwipeIndex: 1, model: "ignored-override" }) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const saved = async () => (await db.select().from(messages).where(eq(messages.id, reply!.id)))[0]!;
  let calls = 0, output = '{"choices":["Inspect the cup","Ask Miveth to explain"]}';
  let beforeDone: (() => Promise<void>) | undefined;
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (request: Parameters<OpenRouterProvider["generateStream"]>[0]) {
    calls++;
    assert.equal(request.model, model);
    assert.equal(request.singleAttempt, true);
    assert.equal(request.disableReasoning, true);
    assert.equal(request.fallbackModels, undefined);
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_TRACE|stateSnapshot|generationState/);
    assert.match(JSON.stringify(request.messages), /The cup is here/);
    assert.match(JSON.stringify(request.messages), /Do not continue the story/);
    assert.match(JSON.stringify(request.messages), /blue coat/);
    assert.match(JSON.stringify(request.messages), /authoritativeState/);
    assert.match(JSON.stringify(request.messages), /Crowns/);
    assert.doesNotMatch(JSON.stringify(request.messages), /HIDDEN_STATE_NEVER_INPUT|Robin/);
    yield { type: "text" as const, content: output };
    await beforeDone?.();
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, providerCostUsd: .001 } };
  });
  await t.test("only the owner and current completed swipe can request options", async () => {
    actor = "someone-else"; assert.equal((await post()).status, 403); actor = uid;
    assert.equal((await post({ activeSwipeIndex: 0 })).status, 409);
    assert.equal((await post({})).status, 400);
    assert.equal(calls, 0);
  });
  await t.test("an explicit call updates choices alone and bills once", async () => {
    const before = await saved();
    const beforeSession = (await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!;
    const response = await post(); const result = await response.json() as { data?: { choices: string[] }; error?: string };
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result.data!.choices, ["Inspect the cup", "Ask Miveth to explain"]);
    const after = await saved();
    assert.deepEqual(after, { ...before, swipes: before.swipes!.map((swipe, i) => i === 1 ? { ...swipe, choices: result.data!.choices } : swipe) });
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0], beforeSession);
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, session!.id))).length, 2);
    assert.equal(await debits(), 1);
    assert.equal(calls, 1);
    assert.equal((await post()).status, 200);
    assert.equal(calls, 1, "existing choices require no second call");
  });
  const clear = async () => { await db.update(messages).set({ swipes: structuredClone(swipes) }).where(eq(messages.id, reply!.id)); };
  await t.test("invalid choices show an error and keep every saved field", async () => {
    await clear(); const before = await saved(); output = '{"choices":["Only one"]}';
    const response = await post(); assert.equal(response.status, 502);
    assert.deepEqual(await saved(), before);
    assert.equal(await debits(), 1);
    assert.ok((await db.select().from(usageLogs).where(eq(usageLogs.userId, uid))).some(row => row.endpoint === "generate-choices-unapplied"));
  });
  await t.test("duplicate clicks do not call the provider twice", async () => {
    await clear(); output = '{"choices":["Inspect the cup","Ask Miveth"]}';
    let unblock!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    beforeDone = async () => { reached(); await gate; };
    const first = post(); await started;
    const beforeCalls = calls; assert.equal((await post()).status, 429); assert.equal(calls, beforeCalls);
    unblock(); assert.equal((await first).status, 200); beforeDone = undefined;
  });
  await t.test("BYOK choices log usage without charging a platform wallet", async () => {
    await clear();
    const key = encryptApiKey("synthetic-byok-key");
    await db.insert(apiKeys).values({ userId: uid, provider: "openrouter", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
    await db.update(user).set({ preferences: { preferredProvider: "private" } }).where(eq(user.id, uid));
    const before = await debits();
    const response = await post(); assert.equal(response.status, 200, await response.text());
    assert.equal(await debits(), before);
    assert.ok((await db.select().from(usageLogs).where(eq(usageLogs.userId, uid))).some(row => row.endpoint === "generate-choices" && row.apiKeyTier === "byok"));
    await db.update(user).set({ preferences: { preferredProvider: "official" } }).where(eq(user.id, uid));
  });
  await t.test("editing or advancing the scene while waiting discards the result without a debit", async () => {
    await clear();
    const beforeDebits = await debits();
    beforeDone = async () => { await db.update(messages).set({ content: "Edited scene" }).where(eq(messages.id, reply!.id)); };
    assert.equal((await post()).status, 409); assert.equal((await saved()).content, "Edited scene");
    assert.deepEqual((await saved()).swipes, swipes);
    assert.equal(await debits(), beforeDebits);
    await db.update(messages).set({ content: scene }).where(eq(messages.id, reply!.id));
    beforeDone = async () => { await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "A new player turn" }); };
    assert.equal((await post()).status, 409);
    assert.deepEqual((await saved()).swipes, swipes);
    beforeDone = undefined;
    const count = calls; assert.equal((await post()).status, 409); assert.equal(calls, count);
  });
});
