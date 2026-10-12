import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, creditTransactions, modelPrices, usageLogs } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import { kevContentClassifier } from "../lib/kev-content-classifier.js";
import { createPendingContentFlags } from "../lib/content-flag-policy.js";
import type { AppEnv } from "../lib/types.js";

const model = "google/gemini-2.5-flash";
const operation = "ending-op-1";
const outcome = "Reach the gate";
const routeGuidance = "The active route is quiet and watchful.";

function makeApp(uid: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes.filter(r => r.path === "/sessions/:sessionId/ending")) app.on(route.method, route.path, route.handler);
  return app;
}

async function fixture(uid: string, mode: "ai" | "authored" = "ai") {
  const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Ending AI test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  const [wallet] = await db.insert(creditWallets).values({ userId: uid, plan: "pro", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) }).returning();
  const world = migrateWorldDefinition({
    id: worldId, version: "19.0.0", name: "Ending test", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User", storyStructureEnabled: true },
    routes: [{ id: "r", name: "Route", enabled: true, priority: 1, guidance: routeGuidance, conditions: [], conditionLogic: "all", lockOnEntry: false }],
    endings: [{ id: "e", name: "End", enabled: true, priority: 1, routeIds: ["r"], conditions: [], conditionLogic: "all", allowUnconditional: true, outcome, mode, prose: mode === "authored" ? "The gate closes." : "", guidance: "Write a quiet conclusion." }],
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const state = { worldId, variables: {}, turnCount: 3, metadata: {}, story: { status: "ending-ready", route: { id: "r", name: "Route", guidance: routeGuidance, enteredTurn: 3, locked: false }, ending: { id: "e", name: "End", outcome, mode, prose: "", guidance: "Write a quiet conclusion.", selectedTurn: 3, operationId: operation } } };
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state }).returning();
  const privateTrace = "PRIVATE_REASONING_MUST_NOT_BE_SENT";
  const content = '[SPEAKER:Miveth:happy] "The gate waits."';
  const swipes = [{ content, rawContent: content, model, choices: [], reasoningContent: privateTrace, stateSnapshot: state, createdAt: new Date().toISOString() }];
  const [reply] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content, swipes, activeSwipeIndex: 0, model, stateSnapshot: state, createdAt: new Date() }).returning();
  return { uid, walletId: wallet!.id, sessionId: session!.id, messageId: reply!.id, state, content, privateTrace };
}

function post(app: Hono<AppEnv>, sessionId: string, messageId: string, op = operation) {
  return app.request(`/sessions/${sessionId}/ending`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: op, messageId, activeSwipeIndex: 0, model }) });
}

async function debitCount(walletId: string) {
  return (await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, walletId))).length;
}

test("AI ending completion persists once, retries safely, fences stale state, and never forwards reasoning", async t => {
  // Transport/state tests use deterministic flags; CPU classifier routing is
  // covered by messages-content-routing.test.ts and its own policy tests.
  t.mock.method(kevContentClassifier, "classify", async (role: "user" | "assistant" | "system", content: string, choices: readonly string[] = []) => ({
    ...createPendingContentFlags(role, content, choices), status: "complete" as const, label: "sfw" as const, routingSafe: true,
    nsfwProbability: .01, sfwProbability: .99, completedAt: new Date().toISOString(), device: "cpu" as const, model: "fixture-kev",
  }));
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: model, context_length: 100000, architecture: { input_modalities: ["text"] } }] }));

  let output = "The gate closes in silence.";
  let calls = 0;
  let beforeDone: (() => Promise<void>) | undefined;
  let signalStarted: (() => void) | undefined;
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (request: Parameters<OpenRouterProvider["generateStream"]>[0]) {
    calls++;
    signalStarted?.();
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /PRIVATE_REASONING_MUST_NOT_BE_SENT/);
    assert.doesNotMatch(serialized, /reasoningContent|stateSnapshot|generationState/);
    assert.match(serialized, /Reach the gate/);
    assert.match(serialized, /active route|quiet and watchful/i);
    yield { type: "text" as const, content: output };
    await beforeDone?.();
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, providerCostUsd: .001 } };
  });

  const first = await fixture(crypto.randomUUID());
  const app = makeApp(first.uid);
  const response = await post(app, first.sessionId, first.messageId);
  const payload = await response.json() as { data?: { message?: any; state?: any; creditCost?: number }; error?: string };
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.data!.state.story.status, "completed");
  assert.match(payload.data!.message.content, /The gate closes/);
  assert.equal(payload.data!.message.swipes[0].choices.length, 0);
  assert.equal(calls, 1);
  assert.equal(await debitCount(first.walletId), 1);
  assert.equal((await db.select().from(usageLogs).where(and(eq(usageLogs.userId, first.uid), eq(usageLogs.endpoint, "complete-ending")))).length, 1);
  const cached = await post(app, first.sessionId, first.messageId);
  assert.equal(cached.status, 200);
  assert.equal(calls, 1);
  assert.equal(await debitCount(first.walletId), 1);

  const failed = await fixture(crypto.randomUUID());
  const failedApp = makeApp(failed.uid);
  output = "Bad output [CHOICES]";
  const failedResponse = await post(failedApp, failed.sessionId, failed.messageId);
  assert.equal(failedResponse.status, 502);
  assert.equal(calls, 2);
  const failedSaved = (await db.select().from(messages).where(eq(messages.id, failed.messageId)))[0]!;
  assert.equal(failedSaved.content, failed.content);
  const failedState = (await db.select().from(playSessions).where(eq(playSessions.id, failed.sessionId)))[0]!.state;
  assert.equal((failedState.story as { status: string }).status, "ending-ready");
  assert.equal(await debitCount(failed.walletId), 0);
  assert.equal((await db.select().from(usageLogs).where(and(eq(usageLogs.userId, failed.uid), eq(usageLogs.endpoint, "complete-ending-unapplied")))).length, 1);
  output = "The gate closes after the failed attempt.";
  assert.equal((await post(failedApp, failed.sessionId, failed.messageId)).status, 200);
  assert.equal(calls, 3);

  const concurrent = await fixture(crypto.randomUUID());
  const concurrentApp = makeApp(concurrent.uid);
  output = "Concurrent ending.";
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  beforeDone = async () => gate;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const pending = post(concurrentApp, concurrent.sessionId, concurrent.messageId);
  await started;
  assert.equal((await post(concurrentApp, concurrent.sessionId, concurrent.messageId)).status, 429);
  unblock();
  assert.equal((await pending).status, 200);
  beforeDone = undefined;

  const stale = await fixture(crypto.randomUUID());
  const staleApp = makeApp(stale.uid);
  output = "Stale ending.";
  let staleRelease!: () => void;
  const staleGate = new Promise<void>(resolve => { staleRelease = resolve; });
  beforeDone = async () => staleGate;
  const staleStarted = new Promise<void>(resolve => { signalStarted = resolve; });
  const stalePending = post(staleApp, stale.sessionId, stale.messageId);
  await staleStarted;
  await db.update(playSessions).set({ state: { ...stale.state, variables: { changed: true } } }).where(eq(playSessions.id, stale.sessionId));
  staleRelease();
  assert.equal((await stalePending).status, 409);
  const staleSaved = (await db.select().from(messages).where(eq(messages.id, stale.messageId)))[0]!;
  assert.equal(staleSaved.content, stale.content);
  assert.equal(await debitCount(stale.walletId), 0);
  assert.equal((await db.select().from(usageLogs).where(and(eq(usageLogs.userId, stale.uid), eq(usageLogs.endpoint, "complete-ending-unapplied")))).length, 1);

  await t.test("AI ending removes player actions while keeping the fixed outcome", async () => {
    beforeDone = undefined;
    signalStarted = undefined;
    const filtered = await fixture(crypto.randomUUID());
    output = '*{{user}} walks through the gate.*\nThe gate closes in silence.';
    const response = await post(makeApp(filtered.uid), filtered.sessionId, filtered.messageId);
    const payload = await response.json() as { data?: { message: any; state: any } };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.data!.state.story.status, "completed");
    assert.match(payload.data!.message.content, /The gate closes in silence/);
    assert.doesNotMatch(JSON.stringify(payload.data), /walks through/);
  });
});
