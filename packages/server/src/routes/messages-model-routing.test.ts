import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, apiKeys, worlds, playSessions, messages } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { encryptApiKey } from "../lib/crypto.js";
import { kevContentClassifier } from "../lib/kev-content-classifier.js";
import { createPendingContentFlags } from "../lib/content-flag-policy.js";
import { normalizeGameState } from "../lib/game-state.js";
import type { AppEnv } from "../lib/types.js";

test("accepted Story replies preserve requested and routed models with a server-derived reason", async t => {
  const isolatedDatabase = db.$client;
  assert.ok(isolatedDatabase instanceof PGlite);
  // PGlite initialization leaves its expected WASM exit status (99) on the
  // Node process; close it before --test-force-exit bypasses beforeExit.
  t.after(async () => { await isolatedDatabase.close(); });
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(), profile = crypto.randomUUID();
  const selected = "custom/accounts/fixture/models/story-selected", fallback = "custom/accounts/fixture/models/story-default";
  await db.insert(user).values({ id: uid, name: "Routing metadata", email: `${uid}@test.local`, preferences: { preferredProvider: "private", activeApiKeyId: profile, nsfwApiKeyId: profile } });
  const key = encryptApiKey("synthetic-model-routing-key");
  await db.insert(apiKeys).values({ id: profile, userId: uid, provider: "custom", baseUrl: "https://model-routing.example/v1", metadata: { defaultModel: fallback.slice(7), models: [selected.slice(7), fallback.slice(7)] }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Routing metadata", description: "", author: "fixture", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 1024, maxContext: 16000 } } as unknown as WorldDefinition);
  world.entries = world.entries.map(entry => entry.presetId === "fiction-mode" ? { ...entry, content: "Run an all-ages town simulation with ordinary conversation." } : entry);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  const paths = ["/sessions/:sessionId/messages", "/messages/:id/regenerate", "/sessions/:sessionId/continue"];
  for (const route of messageRoutes.routes.filter(r => r.method === "POST" && paths.includes(r.path))) app.post(route.path, route.handler);
  let uncertain = false;
  t.mock.method(kevContentClassifier, "classify", async (role: "user" | "assistant" | "system", content: string, choices: readonly string[] = []) => {
    if (uncertain) throw new Error("fixture classifier unavailable");
    return { ...createPendingContentFlags(role, content, choices), status: "complete" as const, label: "sfw" as const, routingSafe: true, nsfwProbability: .01, sfwProbability: .99, completedAt: new Date().toISOString(), device: "cpu" as const, model: "fixture-kev" };
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    assert.equal(String(url), "https://model-routing.example/v1/chat/completions");
    calls.push(JSON.parse(String(init?.body)).model);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "The quiet courtyard remains open." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const events = await response.text(); assert.equal(response.status, 200, events); assert.doesNotMatch(events, /event: error/);
    const done = /event: done\r?\ndata: ([^\r\n]+)/.exec(events); assert.ok(done, events); return JSON.parse(done[1]!);
  };
  const session = async () => (await db.insert(playSessions).values({ userId: uid, worldId, stateGuardEnabled: false, state: normalizeGameState(world, {}) as unknown as Record<string, unknown> }).returning())[0]!;
  await t.test("ordinary selected-model send records selection without inventing a fallback", async () => {
    const s = await session(); const done = await post(`/sessions/${s.id}/messages`, { content: "Wait beside the fountain.", model: selected });
    assert.deepEqual(done.modelRouting, { requestedModel: selected, routedModel: selected });
    const [saved] = await db.select().from(messages).where(eq(messages.id, done.messageId));
    assert.deepEqual((saved!.swipes![0] as any).modelRouting, done.modelRouting);
    assert.equal(saved!.model, selected);
  });
  await t.test("same-connection fallback keeps the exact model and reason through send, regeneration, continuation and reload", async () => {
    const s = await session(); const expected = { requestedModel: selected, routedModel: fallback, reason: "content-fallback" };
    let done = await post(`/sessions/${s.id}/messages`, { content: "Discuss explicit sexual content in the abstract.", model: selected });
    assert.deepEqual(done.modelRouting, expected);
    const id = done.messageId;
    // Force the unchanged request's system context through the same routing path.
    await db.update(worlds).set({ schema: { ...world, entries: [...world.entries, { id: "routing-context", name: "Fixture route", role: "system", apiRole: "system", section: "system-presets", enabled: true, alwaysSend: true, content: "A discussion of sexual content.", position: 999 }] } as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(worlds.id, worldId));
    for (const path of [`/messages/${id}/regenerate`, `/sessions/${s.id}/continue`]) {
      done = await post(path, { model: selected }); assert.deepEqual(done.modelRouting, expected);
      const [saved] = await db.select().from(messages).where(eq(messages.id, id));
      assert.deepEqual((saved!.swipes![saved!.activeSwipeIndex ?? 0] as any).modelRouting, expected);
      assert.equal(saved!.model, fallback);
    }
    assert.equal(calls.at(-1), fallback.slice(7));
    await db.update(worlds).set({ schema: world as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(worlds.id, worldId));
  });
  await t.test("an uncertain content check records uncertainty without exposing provider details", async () => {
    uncertain = true;
    try { const s = await session(); const done = await post(`/sessions/${s.id}/messages`, { content: "Inspect a newly arrived parcel.", model: selected });
      assert.deepEqual(done.modelRouting, { requestedModel: selected, routedModel: fallback, reason: "content-check-uncertain" });
      assert.doesNotMatch(JSON.stringify(done.modelRouting), /profile|https:|key|fixture-key/);
    } finally { uncertain = false; }
  });
});
