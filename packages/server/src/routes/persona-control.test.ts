import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user, worlds, playSessions } from '../db/schema.js';
import { auth } from '../lib/auth.js';
import { sessionRoutes } from './sessions.js';

test('persona control defaults to player, persists per owned session, and rejects malformed and foreign writes', async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: 'Player', email: `${uid}@test.local` }).returning();
  const login = mock.method(auth.api, 'getSession', async () => ({ user: account, session: { id: 'test', userId: uid, expiresAt: new Date(Date.now() + 60000) } }));
  const request = (id: string, method = 'GET', body?: unknown) => sessionRoutes.request(`/${id}/persona-control`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Academy', schema: {} }).returning();
    const [first, second] = await db.insert(playSessions).values([1,2].map(() => ({ userId: uid, worldId: world!.id }))).returning();
    const read = await request(first!.id); assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { data: { mode: string } }).data.mode, 'player');
    for (const mode of ['assisted', 'ai', 'player']) {
      const write = await request(first!.id, 'PATCH', { mode }); assert.equal(write.status, 200);
      assert.equal(((await (await request(first!.id)).json()) as { data: { mode: string } }).data.mode, mode);
      assert.equal(((await (await request(second!.id)).json()) as { data: { mode: string } }).data.mode, 'player');
    }
    for (const body of [{ mode: 'autonomous' }, { mode: 2 }, { mode: 'ai', state: {} }, {}]) assert.equal((await request(first!.id, 'PATCH', body)).status, 400);
    const foreignId = crypto.randomUUID();
    await db.insert(user).values({ id: foreignId, name: 'Another player', email: `${foreignId}@test.local` });
    await db.update(playSessions).set({ userId: foreignId }).where(eq(playSessions.id, first!.id));
    assert.equal((await request(first!.id)).status, 404);
    assert.equal((await request(first!.id, 'PATCH', { mode: 'ai' })).status, 404);
    await db.delete(user).where(eq(user.id, foreignId));
    assert.equal((await request(crypto.randomUUID(), 'PATCH', { mode: 'ai' })).status, 404);
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
