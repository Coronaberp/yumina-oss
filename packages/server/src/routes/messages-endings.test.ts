import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { resolveStoryProgress, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { mergeGameStatePatch } from "../lib/game-state.js";
import { registerExtensionHooks } from "../lib/extension-hooks.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";

test("authored endings are owned, immutable, idempotent, and block further turns", async t => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID();
  let actor: string = uid;
  await db.insert(user).values({ id: uid, name: "Story QA", email: `${uid}@example.test` });
  const prose = '  [SPEAKER:NPC:normal] "The gate closes."  ';
  const world = migrateWorldDefinition({ id: worldId, version: "21.0.0", name: "Story QA", description: "", author: "QA", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {},
    endings: [{ id: "e", name: "Home", enabled: true, priority: 0, routeIds: [], conditions: [], conditionLogic: "all", allowUnconditional: true, outcome: "Arrive home", mode: "authored", prose, guidance: "" }],
  } as unknown as WorldDefinition);
  const pending = resolveStoryProgress(world, { worldId, variables: {}, metadata: {}, turnCount: 1 }, { operationId: "ending-op" });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: pending as unknown as Record<string, unknown> }).returning();
  const sid = session!.id;
  let invalidations = 0, afterInvalidations = 0;
  registerExtensionHooks(SESSION_MEMORY_EXTENSION_KEY, { invalidate: ctx => {
    if (ctx.sessionId !== sid || ctx.reason !== "message-edited") return {};
    invalidations++;
    return { runAfter: async () => { afterInvalidations++; } };
  } });
  await db.insert(messages).values({ sessionId: sid, role: "user", content: "Return home", createdAt: new Date("2026-10-04T01:00:00Z") });
  const scene = '*The road ends at a familiar gate.*';
  const [reply] = await db.insert(messages).values({ sessionId: sid, role: "assistant", status: "complete", content: scene, activeSwipeIndex: 0, createdAt: new Date("2026-10-04T01:00:01Z"), stateSnapshot: pending as unknown as Record<string, unknown>, swipes: [{ content: scene, choices: ["Keep walking"], createdAt: "2026-10-04T01:00:01Z", stateSnapshot: pending as unknown as Record<string, unknown> }] }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes.filter(route => route.method === "POST")) app.on(route.method, route.path, route.handler);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const target = `/sessions/${sid}/ending`;
  const body = { messageId: reply!.id, operationId: "ending-op", activeSwipeIndex: 0 };
  await t.test("rejects forged progression patches", () => {
    const forged = mergeGameStatePatch(world, pending, { story: { status: "completed", presentation: "Forged" } });
    assert.deepEqual(forged.story, pending.story);
  });
  await t.test("validates owner and operation before changing history", async () => {
    actor = "another-user"; assert.equal((await post(target, body)).status, 403); actor = uid;
    assert.equal((await post(target, { ...body, operationId: "wrong" })).status, 409);
    assert.equal((await post(target, { ...body, activeSwipeIndex: 1 })).status, 409);
    assert.equal((await post(target, {})).status, 400);
    assert.equal((await post(target, { ...body, model: {} })).status, 400);
  });
  await t.test("completes without configured model and preserves exact authored prose", async () => {
    const response = await post(target, body);
    const result = await response.json() as { data?: { message: { content: string }; state: typeof pending }; error?: string };
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.data?.message, "Returns the persisted message contract");
    assert.equal(result.data.state.story?.status, "completed");
    assert.equal(result.data.state.story?.presentation, prose);
    assert.ok(result.data.message.content.endsWith(prose));
    const saved = (await db.select().from(messages).where(eq(messages.id, reply!.id)))[0]!;
    assert.deepEqual(saved.swipes?.[0]?.choices, []);
    const cached = await post(target, body); assert.equal(cached.status, 200);
    assert.equal((await db.select().from(messages).where(eq(messages.id, reply!.id)))[0]!.content, saved.content);
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, sid))).length, 2);
    assert.equal(invalidations, 1, "appending the closing reply invalidates derived memory exactly once");
    assert.equal(afterInvalidations, 1, "cached completion must not repeat memory invalidation");
  });
  await t.test("terminal generation paths leave the transcript unchanged", async () => {
    const paths: Array<[string, unknown]> = [[`/sessions/${sid}/messages`, { content: "Go on" }], [`/sessions/${sid}/continue`, {}], [`/messages/${reply!.id}/regenerate`, {}], [`/messages/${reply!.id}/generate-choices`, { activeSwipeIndex: 0 }]];
    for (const [path, payload] of paths) assert.equal((await post(path, payload)).status, 409, path);
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, sid))).length, 2);
  });
});
