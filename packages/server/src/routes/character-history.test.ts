import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user, worlds, playSessions, messages } from '../db/schema.js';
import { auth } from '../lib/auth.js';
import { sessionRoutes } from './sessions.js';
import { CharacterStoryHistory } from '../lib/character-story-history.js';

test('character evidence preserves early encounters, selects relevant scenes and removes hidden output', () => {
  const entries = [{ id: 'maeve', name: 'Maeve', role: 'character' }, { id: 'urabel', name: 'Urabel', role: 'character' }];
  const history = new CharacterStoryHistory(entries, 'maeve', 'Maeve', 18_000);
  history.add('[SPEAKER:Maeve:happy] "OUR_FIRST_MEETING in the library."\n[secret: set "HIDDEN_DIRECTIVE"]\n<think>HIDDEN_THINKING</think>');
  for (let index = 0; index < 20; index++) history.add(`[SPEAKER:Maeve:normal] "Event ${index}: ${'Known actions. '.repeat(120)}"`);
  history.add('[SPEAKER:Urabel:normal] "UNRELATED_ALCHEMY."');
  const text = history.text();
  assert.ok(text.includes('OUR_FIRST_MEETING'));
  assert.ok(text.includes('Event 19'));
  for (const hidden of ['HIDDEN_DIRECTIVE', 'HIDDEN_THINKING', 'UNRELATED_ALCHEMY']) assert.ok(!text.includes(hidden), hidden);
  assert.ok(text.length <= 18_000);
  assert.equal(history.partial, true);
  assert.equal(history.matchedMessages, 21);
  assert.throws(() => new CharacterStoryHistory(entries, 'maeve', 'Urabel'), /does not match/);
});

test('character history reads earlier selected story across pages, keeps summary settings and excludes other sessions and unread pages', async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: 'Player', email: `${uid}@test.local` }).returning();
  const login = mock.method(auth.api, 'getSession', async () => ({ user: account, session: { id: 'test', userId: uid, expiresAt: new Date(Date.now() + 60_000) } }));
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Academy', schema: { id: 'world', name: 'Academy', version: '19.0.0', entries: [
      { id: 'maeve', name: 'Maeve', role: 'character', content: 'HIDDEN_PROFILE', enabled: true },
      { id: 'urabel', name: 'Urabel', role: 'character', content: 'ANOTHER_PROFILE', enabled: true },
    ] } }).returning();
    const [session, another] = await db.insert(playSessions).values([1, 2].map(() => ({ userId: uid, worldId: world!.id, summaryModel: 'configured-summary-model', summaryLanguage: 'en' as const }))).returning();
    const currentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await db.insert(messages).values([
      { sessionId: session!.id, role: 'user', content: 'PLAYER_INTENT meet Maeve', createdAt: new Date('2026-01-01T00:00:00Z') },
      { sessionId: session!.id, role: 'assistant', content: 'Stale row content.', activeSwipeIndex: 1, swipes: [
        { content: '[SPEAKER:Maeve:normal] "INACTIVE_SWIPE"', createdAt: '2026-01-01T00:01:00Z' },
        { content: '[SPEAKER:Maeve:happy] "EARLY_LIBRARY_SCENE."', rawContent: 'RAW_SECRET', reasoningContent: 'REASONING_SECRET', createdAt: '2026-01-01T00:01:00Z' },
      ], createdAt: new Date('2026-01-01T00:01:00Z') },
      { sessionId: another!.id, role: 'assistant', content: '[SPEAKER:Maeve:normal] "OTHER_SESSION_SECRET"', createdAt: new Date('2026-01-01T00:02:00Z') },
      { sessionId: session!.id, role: 'system', content: 'SYSTEM_SECRET Maeve', createdAt: new Date('2026-01-01T00:03:00Z') },
      { sessionId: session!.id, role: 'assistant', content: 'Maeve FAILED_REPLY_SECRET', status: 'failed', createdAt: new Date('2026-01-01T00:04:00Z') },
      { id: currentId, sessionId: session!.id, role: 'assistant', content: '[SPEAKER:Maeve:normal] "CURRENT_UNREAD_PAGE_SECRET"', createdAt: new Date('2026-01-03T00:00:00Z') },
      { sessionId: session!.id, role: 'assistant', content: '[SPEAKER:Maeve:normal] "FUTURE_SECRET"', createdAt: new Date('2026-01-04T00:00:00Z') },
    ] satisfies (typeof messages.$inferInsert)[]);
    await db.insert(messages).values(Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, sessionId: session!.id, role: 'assistant' as const,
      content: index === 204 ? '[SPEAKER:Maeve:normal] "LATER_MAEVE_PROMISE"' : '[SPEAKER:Urabel:normal] "UNRELATED_RECENT_SCENE"', createdAt: new Date('2026-01-02T00:00:00Z'),
    })));
    const request = (id = session!.id, extra = '') => sessionRoutes.request(`/${id}/character-history?characterId=maeve&label=Maeve&beforeMessageId=${currentId}${extra}`);
    const response = await request(); assert.equal(response.status, 200);
    const data = (await response.json() as { data: { text: string; partial: boolean; model: string; language: string; scannedMessages: number; matchedMessages: number } }).data;
    assert.equal(data.model, 'configured-summary-model'); assert.equal(data.language, 'en');
    assert.equal(data.partial, false); assert.equal(data.matchedMessages, 2); assert.ok(data.scannedMessages > 200);
    for (const visible of ['EARLY_LIBRARY_SCENE', 'LATER_MAEVE_PROMISE', 'PLAYER_INTENT']) assert.ok(data.text.includes(visible), visible);
    for (const hidden of ['INACTIVE_SWIPE', 'RAW_SECRET', 'REASONING_SECRET', 'HIDDEN_PROFILE', 'OTHER_SESSION_SECRET', 'SYSTEM_SECRET', 'CURRENT_UNREAD_PAGE_SECRET', 'FUTURE_SECRET', 'FAILED_REPLY_SECRET', 'UNRELATED_RECENT_SCENE']) assert.ok(!data.text.includes(hidden), hidden);
    assert.equal((await request(another!.id)).status, 404);
    assert.equal((await request(session!.id, '&swipeIndex=1')).status, 409);
    const other = crypto.randomUUID();
    await db.insert(user).values({ id: other, name: 'Other', email: `${other}@test.local` });
    await db.update(playSessions).set({ userId: other }).where(eq(playSessions.id, session!.id));
    assert.equal((await request()).status, 404);
    await db.delete(user).where(eq(user.id, other));
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
