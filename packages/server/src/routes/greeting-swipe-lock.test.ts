import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { messageRoutes } from "./messages.js";

test("opening swipes select the chapter at the greeting and cannot reset a played session", async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: "Opening QA", email: `${uid}@example.test` }).returning();
  const login = mock.method(auth.api, "getSession", async () => ({ user: account, session: { id: "test", userId: uid, expiresAt: new Date(Date.now() + 60000) } }));
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Chapters", schema: { version: "21.0.0", name: "Chapters", entries: [], variables: [], rules: [], components: [], audioTracks: [], settings: {} } }).returning();
    const state = { turnCount: 0, activeGreetingId: "origin", activeChapterId: "origin", variables: {}, metadata: {} };
    const holder = { ...state, activeGreetingId: "holder", activeChapterId: "holder" };
    const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state }).returning();
    const [greeting] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Origin", stateSnapshot: state,
      swipes: [{ content: "Origin", stateSnapshot: state, createdAt: new Date().toISOString() }, { content: "Holder", stateSnapshot: holder, createdAt: new Date().toISOString() }] }).returning();
    const swipe = (body: object) => messageRoutes.request(`/messages/${greeting!.id}/swipe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await swipe({ index: 1 })).status, 200);
    assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.state.activeChapterId, "holder");
    await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "Begin." });
    const before = (await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.state;
    assert.equal((await swipe({ index: 0 })).status, 409);
    assert.equal((await swipe({ direction: "left" })).status, 409);
    assert.equal((await db.select().from(messages).where(eq(messages.id, greeting!.id)))[0]!.content, "Holder");
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.state, before);
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
