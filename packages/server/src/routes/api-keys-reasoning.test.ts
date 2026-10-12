import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, user } from '../db/schema.js';
import { apiKeyRoutes } from './api-keys.js';
import { resolveProviderForModel } from '../lib/resolve-provider.js';
import type { AppEnv } from '../lib/types.js';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => { c.set('user', { id: 'effort-owner' } as never); await next(); });
for (const route of apiKeyRoutes.routes) {
  if (route.method === 'PATCH' && route.path === '/:id') app.patch(route.path, route.handler);
  if (route.method === 'POST' && route.path === '/') app.post(route.path, route.handler);
}

test('legacy provider selection carries the active non-custom endpoint effort into the request', async t => {
  const created = await request('POST', '/', { provider: 'openai', key: 'fixture-only', reasoningEffort: 'high' });
  const { data } = await created.json() as any;
  await db.update(user).set({ preferences: { preferredProvider: 'private', activeApiKeyId: data.id } }).where(eq(user.id, 'effort-owner'));
  const resolved = await resolveProviderForModel('effort-owner', 'openai/gpt-5.1', { allowNonPriced: true });
  assert.ok(resolved);
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
  });
  for await (const _ of resolved.provider.generateStream({ model: 'openai/gpt-5.1', messages: [{ role: 'user', content: 'Hi' }], stream: false, reasoningEffort: 'low' })) {}
  assert.equal(body.reasoning_effort, 'high');
});
before(async () => { await db.insert(user).values({ id: 'effort-owner', name: 'Effort owner', email: 'effort@test.invalid' }); });
const request = (method: string, path: string, body: unknown) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

for (const provider of ['custom', 'openai', 'anthropic', 'google', 'openrouter', 'ollama']) {
  test(`${provider} profiles save independent story creativity settings and validate updates`, async () => {
    const create = (settings = {}) => request('POST', '/', { provider, key: 'fixture-only', ...(provider === 'custom' && { baseUrl: 'https://example.com/v1' }), ...settings });
    const defaults = await create();
    assert.equal(defaults.status, 201);
    const { data } = await defaults.json() as any;
    assert.equal(data.metadata.temperature, 0.8);
    assert.equal(data.metadata.topP, 0.95);
    assert.equal(data.metadata.topK, 40);
    const another = await create({ temperature: 0.6, topP: 0.9, topK: 60 });
    assert.equal(another.status, 201);
    assert.equal(((await another.json()) as any).data.metadata.topK, 60);
    assert.equal((await request('PATCH', `/${data.id}`, { temperature: 0, topP: 1, topK: 0 })).status, 200);
    for (const bad of [{ temperature: -1 }, { temperature: 2.1 }, { temperature: '0.8' }, { topP: 0 }, { topP: 1.1 }, { topK: -1 }, { topK: 1.5 }]) {
      assert.equal((await request('PATCH', `/${data.id}`, bad)).status, 400, JSON.stringify(bad));
    }
    const [saved] = await db.select().from(apiKeys).where(eq(apiKeys.id, data.id));
    assert.equal((saved!.metadata as any).temperature, 0);
    assert.equal((saved!.metadata as any).topP, 1);
    assert.equal((saved!.metadata as any).topK, 0);
    assert.equal((await request('PATCH', `/${data.id}`, { defaultModel: 'another-model' })).status, 200);
    const [afterModelEdit] = await db.select().from(apiKeys).where(eq(apiKeys.id, data.id));
    assert.equal((afterModelEdit!.metadata as any).temperature, 0);
    assert.equal((afterModelEdit!.metadata as any).topP, 1);
    assert.equal((afterModelEdit!.metadata as any).topK, 0);
    assert.equal((await request('PATCH', `/${data.id}`, { temperature: null, topP: null, topK: null })).status, 200);
  });

  test(`${provider} profiles default to low and persist user-selected effort`, async () => {
    const res = await request('POST', '/', { provider, key: 'fixture-only', ...(provider === 'custom' && { baseUrl: 'https://example.com/v1' }) });
    assert.equal(res.status, 201);
    const { data } = await res.json() as any;
    assert.equal(data.metadata?.reasoningEffort, 'low');
    assert.equal((await request('PATCH', `/${data.id}`, { reasoningEffort: 'high', defaultModel: 'selected-model' })).status, 200);
    const [saved] = await db.select().from(apiKeys).where(eq(apiKeys.id, data.id));
    assert.equal((saved!.metadata as any).reasoningEffort, 'high');
    assert.equal(saved!.metadata?.defaultModel, 'selected-model');
    assert.equal((await request('PATCH', `/${data.id}`, { reasoningEffort: 'unbounded' })).status, 400);
    const [unchanged] = await db.select().from(apiKeys).where(eq(apiKeys.id, data.id));
    assert.equal((unchanged!.metadata as any).reasoningEffort, 'high');
    const chosen = await request('POST', '/', { provider, key: 'fixture-only', reasoningEffort: 'medium', ...(provider === 'custom' && { baseUrl: 'https://example.com/v1' }) });
    assert.equal(chosen.status, 201);
    assert.equal(((await chosen.json()) as any).data.metadata.reasoningEffort, 'medium');
  });
}
