import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { chapterSchema, migrateWorldDefinition, GameStateManager, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { registerChapterRoutes } from "./session-chapters.js";
import type { AppEnv } from "../lib/types.js";

test("chapters are greeting-only choices and the legacy transition endpoint cannot change a save", async t => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID(); let actor = uid;
  await db.insert(user).values({ id: uid, name: "Chapter QA", email: `${uid}@example.test` });
  t.after(() => db.delete(user).where(eq(user.id, uid)));
  const world = migrateWorldDefinition({ id: worldId, version: "21.0.0", name: "Chapter QA", description: "", author: "QA",
    entries: [{ id: "g", name: "Opening", role: "greeting", content: "At dawn." }], variables: [],
    chapters: [chapterSchema.parse({ id: "origin", name: "Origin", greetingIds: ["g"], nextChapterIds: ["holder"] }), chapterSchema.parse({ id: "holder", name: "Holder" })],
    rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  const state = new GameStateManager(world, { worldId, variables: {}, metadata: {}, activeGreetingId: "g", turnCount: 0 }).getSnapshot();
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: state as unknown as Record<string, unknown> }).returning();
  const sid = session!.id;
  const [reply] = await db.insert(messages).values({ sessionId: sid, role: "assistant", content: "Opening.", stateSnapshot: state as unknown as Record<string, unknown> }).returning();
  const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); }); registerChapterRoutes(app);
  const post = () => app.request(`/${sid}/chapters/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: "holder", expectedChapterId: "origin", latestMessageId: reply!.id }) });
  const initial = await app.request(`/${sid}/chapters`);
  assert.equal(initial.status, 200);
  const body = await initial.json() as any;
  assert.equal(body.data.chapters[0].name, "Origin");
  assert.deepEqual(body.data.chapters[0].greetingIds, ["g"]);
  assert.equal(body.data.chapters[0].nextChapterIds, undefined);
  assert.equal((await post()).status, 409, "even legacy edges cannot append a transition");
  await db.insert(messages).values({ sessionId: sid, role: "user", content: "Begin." });
  assert.equal((await app.request(`/${sid}/chapters`)).status, 409, "a player input permanently closes chapter selection");
  assert.equal((await post()).status, 409);
  assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, sid)))[0]!.state, state);
  assert.equal((await db.select().from(messages).where(eq(messages.sessionId, sid))).length, 2);
  actor = crypto.randomUUID();
  assert.equal((await post()).status, 404);
  assert.equal((await app.request(`/${sid}/chapters`)).status, 404);
});
