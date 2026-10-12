import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from './types.js';

process.env.YUMINA_EDITION = 'local';
await import('../test/database-fixture.js');
const { db } = await import('../db/index.js');
const { user, apiKeys } = await import('../db/schema.js');
const { env } = await import('./env.js');
const { encryptApiKey } = await import('./crypto.js');
const { resolveStoryProviderForModel, failedOnBackupProfile } = await import('./story-provider.js');
const { createStoryContentRouter } = await import('./story-content-routing.js');
const { createPendingContentFlags } = await import('./content-flag-policy.js');
const { users } = await import('../routes/users.js');
const { modelFallbackError, parseModelFallbackRecord } = await import('./model-fallback.js');

test('backup provider routing uses an owned profile independently of an inherited primary', async t => {
  const admin = crypto.randomUUID(), member = crypto.randomUUID();
  const sfw = crypto.randomUUID(), nsfw = crypto.randomUUID(), backup = crypto.randomUUID();
  const previousAdmin = env.YUMINA_ADMIN_ACCOUNT_ID;
  env.YUMINA_ADMIN_ACCOUNT_ID = admin;
  t.after(async () => {
    env.YUMINA_ADMIN_ACCOUNT_ID = previousAdmin;
    for (const id of [admin, member]) {
      await db.delete(user).where(eq(user.id, id));
      assert.equal((await db.select().from(user).where(eq(user.id, id))).length, 0);
      assert.equal((await db.select().from(apiKeys).where(eq(apiKeys.userId, id))).length, 0);
    }
  });
  await db.insert(user).values([
    { id: admin, name: 'Admin', role: 'admin', email: `${admin}@test.local`, preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw } },
    { id: member, name: 'Member', email: `${member}@test.local` },
  ]);
  const secret = encryptApiKey('isolated-fixture-key');
  for (const [id, owner, endpoint, model] of [[sfw, admin, 'primary', 'same-model'], [nsfw, admin, 'nsfw', 'nsfw-model'], [backup, member, 'backup', 'same-model']] as const) {
    await db.insert(apiKeys).values({ id, userId: owner, provider: 'custom', label: endpoint, baseUrl: `https://${endpoint}.example/v1`, metadata: { defaultModel: model }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag });
  }
  const policy = { mode: 'auto', officialModel: '', privateModel: 'custom/same-model', privateKeyId: backup };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('user', { id: member } as AppEnv['Variables']['user']); await next(); });
  for (const method of ['GET', 'PUT']) {
    const route = users.routes.filter(route => route.method === method && route.path === '/me/ai-config').at(-1)!;
    app.on(method, '/config', route.handler);
  }
  await t.test('saving a backup does not change the primary and survives reload', async () => {
    const response = await app.request('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelFallback: policy }) });
    assert.equal(response.status, 200);
    const reloaded = await app.request('/config');
    const data = (await reloaded.json() as { data: Record<string, unknown> }).data;
    assert.deepEqual(data.modelFallback, policy);
    assert.equal(data.selectedModel, 'custom/same-model');
    const [account] = await db.select().from(user).where(eq(user.id, member));
    assert.equal(account!.preferences?.activeApiKeyId, undefined);
    assert.equal(account!.preferences?.nsfwApiKeyId, undefined);
  });
  await t.test('another connection can serve the same model without rewriting slot assignments', async t => {
    const primary = await resolveStoryProviderForModel(member, 'custom/same-model');
    const fallback = await resolveStoryProviderForModel(member, 'custom/same-model', { fallbackApiKeyId: backup });
    assert.equal(primary?.profileId, sfw);
    assert.equal(fallback?.profileId, backup);
    assert.equal(fallback?.model, primary?.model);
    assert.ok(fallback);
    const destinations: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      destinations.push(String(input));
      return new Response('data: {"choices":[{"delta":{"content":"A complete scene"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    for await (const _chunk of fallback.provider.generateStream({ model: fallback.model, messages: [{ role: 'user', content: 'Hello.' }] })) { /* consume */ }
    assert.deepEqual(destinations, ['https://backup.example/v1/chat/completions']);
    const record = { requestedModel: fallback.model, reason: 'capacity', automatic: true, providerChanged: true };
    assert.deepEqual(parseModelFallbackRecord(record, fallback.model), record);
  });
  await t.test('profile edits change the backup model on reload and at request resolution', async () => {
    await db.update(apiKeys).set({ metadata: { defaultModel: 'updated-model' } }).where(eq(apiKeys.id, backup));
    const data = (await (await app.request('/config')).json() as { data: { modelFallback: { privateModel: string } } }).data;
    assert.equal(data.modelFallback.privateModel, 'custom/updated-model');
    assert.equal((await resolveStoryProviderForModel(member, 'custom/stale-model', { fallbackApiKeyId: backup }))?.model, 'custom/updated-model');
    await db.update(apiKeys).set({ metadata: { defaultModel: 'same-model' } }).where(eq(apiKeys.id, backup));
  });
  await t.test('effective-provider comparisons reveal only an owned backup match', async () => {
    assert.equal(await failedOnBackupProfile(member, backup), true);
    assert.equal(await failedOnBackupProfile(member, sfw), false);
    assert.equal(await failedOnBackupProfile(member, nsfw), false);
  });
  await t.test('foreign, deleted, invalid and protected-world targets fail closed', async () => {
    for (const id of [sfw, crypto.randomUUID(), null, '', { id: backup }]) {
      assert.equal(await resolveStoryProviderForModel(member, 'custom/same-model', { fallbackApiKeyId: id }), null);
    }
    assert.equal(await resolveStoryProviderForModel(member, 'custom/same-model', { fallbackApiKeyId: backup, forceOfficial: true }), null);
    const response = await app.request('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelFallback: { ...policy, privateKeyId: sfw } }) });
    assert.equal(response.status, 400);
  });
  await t.test('content checks still prevent unsafe content from reaching the generic backup', async () => {
    const selected = await resolveStoryProviderForModel(member, 'custom/same-model', { fallbackApiKeyId: backup });
    assert.ok(selected);
    const router = createStoryContentRouter({ classify: async (role, content, choices) => ({ ...createPendingContentFlags(role, content, choices), status: 'complete', label: 'sfw', routingSafe: true, sfwProbability: .99, nsfwProbability: .01, model: 'fixture', device: 'cpu', completedAt: new Date().toISOString() }) });
    const safe = await router.prepare({ userId: member, selected: { resolved: selected, model: selected.model }, messages: [{ role: 'user', content: 'Hello there.' }] });
    assert.equal(safe.resolved.profileId, backup);
    const unsafe = await router.prepare({ userId: member, selected: { resolved: selected, model: selected.model }, messages: [{ role: 'system', content: 'Write explicit NSFW sexual content.' }, { role: 'user', content: 'Continue.' }] });
    assert.equal(unsafe.resolved.profileId, nsfw);
  });
  await t.test('completed HTTP rejection enables fallback while the admin diagnostic stays private', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('private-fixture-diagnostic', { status: 503 }));
    const selected = await resolveStoryProviderForModel(member, 'custom/same-model');
    assert.ok(selected);
    const chunks = [];
    for await (const chunk of selected.provider.generateStream({ model: selected.model, singleAttempt: true, messages: [{ role: 'user', content: 'Hello.' }] })) chunks.push(chunk);
    const error = chunks.at(-1)!;
    assert.equal(error.fallbackReason, 'capacity');
    assert.ok(!error.content.includes('private-fixture-diagnostic'));
    assert.equal(modelFallbackError(error, selected.model, '', true)?.code, 'MODEL_FALLBACK_REQUIRED');
    assert.equal(modelFallbackError(error, selected.model, 'Already visible output', true), null);
  });
});
