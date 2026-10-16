import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user, worlds, playSessions, messages } from '../db/schema.js';
import { auth } from '../lib/auth.js';
import { sessionRoutes } from './sessions.js';

test('encounter history uses earlier active assistant turns, excluding mentions, future pages, other swipes and sessions', async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: 'Player', email: `${uid}@test.local` }).returning();
  const login = mock.method(auth.api, 'getSession', async () => ({ user: account, session: { id: 'test', userId: uid, expiresAt: new Date(Date.now() + 60000) } }));
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Academy', schema: { id: 'world', name: 'Academy', version: '19.0.0', entries: [
      { id: 'diane', name: 'Diane Bluerose', role: 'character', content: '', enabled: true },
      { id: 'ryu', name: 'Ryu (Ryutharax)', role: 'character', content: '', enabled: true },
    ] } }).returning();
    const [session, another] = await db.insert(playSessions).values([1,2].map(() => ({ userId: uid, worldId: world!.id }))).returning();
    const oldId = crypto.randomUUID(), currentId = crypto.randomUUID();
    await db.insert(messages).values([
      { id: oldId, sessionId: session!.id, role: 'assistant', content: '[SPEAKER:Diane:normal] "Hello."', createdAt: new Date('2026-01-01T00:00:00Z') },
      { sessionId: session!.id, role: 'assistant', content: '*Ryu is mentioned in a rumor.*', createdAt: new Date('2026-01-02T00:00:00Z'), activeSwipeIndex: 1,
        swipes: [{ content: '[SPEAKER:Ryu:normal] "Unused swipe."', createdAt: '2026-01-02T00:00:00Z' }, { content: '*A rumor about Ryu.*', createdAt: '2026-01-02T00:00:00Z' }] },
      { sessionId: session!.id, role: 'user', content: '[SPEAKER:Ryu:normal] "Player text is not an encounter."', createdAt: new Date('2026-01-03T00:00:00Z') },
      { id: currentId, sessionId: session!.id, role: 'assistant', content: '[SPEAKER:Ryu:normal] "Unread current turn."', createdAt: new Date('2026-01-04T00:00:00Z') },
      { sessionId: another!.id, role: 'assistant', content: '[SPEAKER:Ryu:normal] "Another session."', createdAt: new Date('2025-01-01T00:00:00Z') },
    ] satisfies (typeof messages.$inferInsert)[]);
    const request = (id: string, before: string) => sessionRoutes.request(`/${id}/character-encounters?beforeMessageId=${before}`);
    const response = await request(session!.id, currentId); assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as {data:{characterIds:string[]}}).data.characterIds, ['diane']);
    assert.deepEqual((await (await request(session!.id, oldId)).json() as {data:{characterIds:string[]}}).data.characterIds, []);
    assert.equal((await request(another!.id, currentId)).status, 404);
    // Same timestamp deliberately exercises the UUID tie-breaker across pages.
    const earlier = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sessionId: session!.id, role: 'assistant' as const,
      content: index === 204 ? '[SPEAKER:Ryu:smug] "A prior encounter."' : '*A quiet moment.*',
      createdAt: new Date('2026-01-03T12:00:00Z'),
    }));
    await db.insert(messages).values(earlier);
    assert.deepEqual(new Set((await (await request(session!.id, currentId)).json() as {data:{characterIds:string[]}}).data.characterIds), new Set(['diane', 'ryu']));
    const foreignId = crypto.randomUUID();
    await db.insert(user).values({ id: foreignId, name: 'Other', email: `${foreignId}@test.local` });
    await db.update(playSessions).set({ userId: foreignId }).where(eq(playSessions.id, session!.id));
    assert.equal((await request(session!.id, currentId)).status, 404);
    await db.delete(user).where(eq(user.id, foreignId));
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
