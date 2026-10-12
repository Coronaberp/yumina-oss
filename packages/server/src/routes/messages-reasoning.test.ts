import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, modelPrices } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import type { AppEnv } from "../lib/types.js";
import { registerStream } from "../lib/stream-registry.js";

test("reply traces survive send, regeneration, reload and continuation without entering future prompts", async t => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const model = "google/gemini-2.5-flash";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: model, context_length: 1048576, architecture: { input_modalities: ["text"] } },
  ] }));
  let attempt = 0;
  const prompts: unknown[] = [];
  const trace = (index: number) => `DISPLAY_ONLY_TRACE_${index}: plan this reply`;
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (request: Parameters<OpenRouterProvider["generateStream"]>[0]) {
    prompts.push(structuredClone(request));
    const index = ++attempt;
    if (index !== 5) {
      yield { type: "reasoning" as const, content: `DISPLAY_ONLY_TRACE_${index}: ` };
      yield { type: "reasoning" as const, content: "plan this reply" };
    }
    yield { type: "text" as const, content: `[SPEAKER:Miveth:happy] "A story reply for attempt ${index}."\n[CHOICES: ["Wait ${index}", "Leave ${index}"]]` };
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
  });
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Trace test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  await db.insert(creditWallets).values({ userId: uid, plan: "internal", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Trace test", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const pattern of ["/sessions/:sessionId/messages", "/sessions/:sessionId/continue", "/messages/:id/regenerate", "/messages/:id/swipe", "/messages/:id"]) {
    for (const route of messageRoutes.routes.filter(r => r.path === pattern)) {
      app.on(route.method, pattern, route.handler);
    }
  }
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const done = async (response: Response): Promise<Record<string, unknown>> => {
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.doesNotMatch(stream, /event: error/);
    const event = stream.split("\n\n").find(part => part.includes("event: done\n"));
    assert.ok(event, stream);
    return JSON.parse(event.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  };
  const sendPath = `/sessions/${session!.id}/messages`;
  const sent = await done(await post(sendPath, { content: "Start the scene", model }));
  assert.equal(sent.reasoningContent, trace(1));
  assert.deepEqual(sent.choices, ["Wait 1", "Leave 1"]);
  assert.match(sent.content as string, /\[SPEAKER:Miveth:happy\]/);
  const messageId = sent.messageId as string;
  const saved = async () => (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!;
  const swipeTrace = (swipe: unknown) => (swipe as Record<string, unknown>).reasoningContent;
  assert.equal(swipeTrace((await saved()).swipes![0]), trace(1));
  const regenerated = await done(await post(`/messages/${messageId}/regenerate`, { model }));
  assert.equal(regenerated.reasoningContent, trace(2));
  assert.deepEqual(regenerated.choices, ["Wait 2", "Leave 2"]);
  assert.deepEqual((await saved()).swipes!.map(swipeTrace), [trace(1), trace(2)]);
  const selected = await post(`/messages/${messageId}/swipe`, { index: 0 });
  assert.equal(selected.status, 200);
  assert.deepEqual((await selected.json() as { data: { choices: string[] } }).data.choices, ["Wait 1", "Leave 1"]);
  const continued = await done(await post(`/sessions/${session!.id}/continue`, { model }));
  assert.equal(continued.reasoningContent, `${trace(1)}\n\n${trace(3)}`);
  assert.deepEqual(continued.choices, ["Wait 3", "Leave 3"]);
  assert.deepEqual((await saved()).swipes!.map(swipeTrace), [`${trace(1)}\n\n${trace(3)}`, trace(2)]);
  const reloadedResponse = await app.request(sendPath);
  assert.equal(reloadedResponse.status, 200);
  const reloaded = await reloadedResponse.json() as { data: Array<{ id: string; swipes: unknown[] }> };
  assert.deepEqual(reloaded.data.find(item => item.id === messageId)!.swipes.map(swipeTrace), [`${trace(1)}\n\n${trace(3)}`, trace(2)]);
  assert.deepEqual(reloaded.data.find(item => item.id === messageId)!.swipes.map(s => (s as any).choices), [["Wait 3", "Leave 3"], ["Wait 2", "Leave 2"]]);
  const next = await done(await post(sendPath, { continue: true, model }));
  assert.equal(next.reasoningContent, trace(4));
  assert.deepEqual(next.choices, ["Wait 4", "Leave 4"]);
  const noTrace = await done(await post(sendPath, { content: "Finish the scene", model }));
  assert.equal(noTrace.reasoningContent, undefined);
  // A refreshed/restarted session can end with a complete user row whose
  // generation never completed. An explicit retry must reuse that row.
  const pendingContent = "A saved choice without a response";
  const [pending] = await db.insert(messages).values({ sessionId: session!.id, role: "user", content: pendingContent, status: "complete" }).returning();
  const beforeRetry = await db.select().from(messages).where(eq(messages.sessionId, session!.id));
  const active = registerStream(new AbortController(), session!.id);
  try {
    const duplicate = await post(sendPath, { content: pendingContent, retryMessageId: pending!.id, model });
    assert.equal(duplicate.status, 409);
    const changeChoice = await app.request(`/messages/${pending!.id}`, { method: "DELETE" });
    assert.equal(changeChoice.status, 409, "an in-progress player choice cannot be removed");
    assert.equal((await db.select().from(messages).where(eq(messages.id, pending!.id))).length, 1);
    assert.equal(attempt, 5, "an active reply must not dispatch a duplicate provider call");
  } finally { active(); }
  const recovered = await done(await post(sendPath, { content: pendingContent, retryMessageId: pending!.id, model }));
  assert.equal(recovered.reasoningContent, trace(6));
  const afterRetry = await db.select().from(messages).where(eq(messages.sessionId, session!.id));
  assert.equal(afterRetry.length, beforeRetry.length + 1, "only the missing assistant reply is appended");
  assert.equal(afterRetry.filter(row => row.role === "user" && row.content === pendingContent).length, 1);
  assert.ok(afterRetry.some(row => row.id === pending!.id));
  assert.doesNotMatch(JSON.stringify(prompts), /DISPLAY_ONLY_TRACE_|reasoningContent/, "stored thinking must never become model input");
});
