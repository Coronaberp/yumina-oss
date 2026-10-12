import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from './types.js';

process.env.YUMINA_EDITION = 'local';
await import('../test/database-fixture.js');
const { db } = await import('../db/index.js');
const { user, apiKeys } = await import('../db/schema.js');
const { env } = await import('./env.js');
const { encryptApiKey } = await import('./crypto.js');
const { resolveStoryProviderForModel } = await import('./story-provider.js');
const { resolveStudioNsfwProvider } = await import('./studio-nsfw-provider.js');
const { createStoryContentRouter } = await import('./story-content-routing.js');
const { createPendingContentFlags } = await import('./content-flag-policy.js');
const { apiKeyRoutes } = await import('../routes/api-keys.js');
const { users: userRoutes } = await import('../routes/users.js');
const { messageRoutes } = await import('../routes/messages.js');
const { generateStreamWithRetry } = await import('./studio-tools/generate-stream-with-retry.js');
const { resolveGuardModel } = await import('../extensions/state-update-guard/model.js');
const { guardTurnOutput } = await import('../extensions/state-update-guard/validate.js');
const { GameStateManager, ResponseParser } = await import('@yumina/engine');

test('all local accounts inherit the pinned admin SFW and NSFW defaults without owning its credentials', async t => {
  const admin = crypto.randomUUID(), member = crypto.randomUUID(), fresh = crypto.randomUUID(), custom = crypto.randomUUID();
  const sfw = crypto.randomUUID(), nsfw = crypto.randomUUID(), ownSfw = crypto.randomUUID(), ownNsfw = crypto.randomUUID();
  const previousAdmin = env.YUMINA_ADMIN_ACCOUNT_ID;
  env.YUMINA_ADMIN_ACCOUNT_ID = admin;
  t.after(async () => { env.YUMINA_ADMIN_ACCOUNT_ID = previousAdmin; for (const id of [admin, member, fresh, custom]) await db.delete(user).where(eq(user.id, id)); });
  await db.insert(user).values([
    { id: admin, name: 'Admin', role: 'admin', email: `${admin}@test.local`, preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw } },
    { id: member, name: 'Existing member', email: `${member}@test.local`, preferences: { theme: 'gold', aiConfig: { selectedModel: 'anthropic/legacy-model' } } },
    { id: fresh, name: 'New member', email: `${fresh}@test.local` },
    { id: custom, name: 'Private member', email: `${custom}@test.local`, preferences: { activeApiKeyId: ownSfw, nsfwApiKeyId: ownNsfw } },
  ]);
  const secret = encryptApiKey('admin-fixture-secret-never-public');
  for (const [id, userId, model, endpoint] of [[sfw, admin, 'admin-sfw-model', 'admin-sfw'], [nsfw, admin, 'admin-nsfw-model', 'admin-nsfw'], [ownSfw, custom, 'own-sfw-model', 'own-sfw'], [ownNsfw, custom, 'own-nsfw-model', 'own-nsfw']] as const) {
    await db.insert(apiKeys).values({ id, userId, provider: 'custom', baseUrl: `https://${endpoint}.example/v1`, metadata: { defaultModel: model }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag });
  }
  let actor = member;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('user', { id: actor } as AppEnv['Variables']['user']); await next(); });
  for (const route of apiKeyRoutes.routes.filter(route => route.path === '/content-endpoints' && ['GET', 'PATCH'].includes(route.method))) app.on(route.method, '/endpoints', route.handler);
  const config = userRoutes.routes.filter(route => route.method === 'GET' && route.path === '/me/ai-config').at(-1)!;
  app.get('/config', config.handler);
  const saveConfig = userRoutes.routes.filter(route => route.method === 'PUT' && route.path === '/me/ai-config').at(-1)!;
  app.put('/config', saveConfig.handler);
  const listKeys = apiKeyRoutes.routes.filter(route => route.method === 'GET' && route.path === '/').at(-1)!;
  app.get('/keys', listKeys.handler);
  const editKey = apiKeyRoutes.routes.filter(route => route.method === 'PATCH' && route.path === '/:id').at(-1)!;
  app.patch('/keys/:id', editKey.handler);
  const models = messageRoutes.routes.filter(route => route.method === 'GET' && route.path === '/models').at(-1)!;
  app.get('/models', models.handler);
  const initial = (await db.select().from(user).where(eq(user.id, member)))[0]!.preferences;

  await t.test('existing and new accounts use the configured admin models rather than a client placeholder', async () => {
    for (const id of [member, fresh]) {
      const story = await resolveStoryProviderForModel(id, 'custom/client-placeholder');
      const studio = await resolveStudioNsfwProvider(id);
      assert.equal(story?.model, 'custom/admin-sfw-model');
      assert.equal(story?.profileId, sfw);
      assert.equal(studio?.model, 'custom/admin-nsfw-model');
      assert.equal(studio?.profileId, nsfw);
    }
  });
  await t.test('the public model catalog includes the inherited Story default without provider discovery', async () => {
    const result = await app.request('/models');
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json() as {data: {all: {id:string}[]}}).data.all.map(model => model.id), ['custom/admin-sfw-model']);
  });
  await t.test('unknown accounts cannot inherit shared credentials', async () => {
    const id = crypto.randomUUID();
    assert.equal(await resolveStoryProviderForModel(id, 'custom/placeholder'), null);
    assert.equal(await resolveStudioNsfwProvider(id), null);
  });
  await t.test('Story routes unsafe content to the inherited admin NSFW destination', async () => {
    const selected = await resolveStoryProviderForModel(member, 'custom/client-placeholder');
    assert.ok(selected);
    const router = createStoryContentRouter({ classify: async (role, content, choices) => ({ ...createPendingContentFlags(role, content, choices), status: 'complete', label: 'sfw', routingSafe: true, nsfwProbability: .01, sfwProbability: .99, device: 'cpu', model: 'fixture', completedAt: new Date().toISOString() }) });
    const safe = await router.prepare({ userId: member, selected: { resolved: selected, model: selected.model }, messages: [{ role: 'user', content: 'Hello there.' }] });
    assert.equal(safe.model, 'custom/admin-sfw-model');
    const unsafe = await router.prepare({ userId: member, selected: { resolved: selected, model: selected.model }, messages: [{ role: 'system', content: 'Write explicit NSFW sexual content.' }, { role: 'user', content: 'Continue.' }] });
    assert.equal(unsafe.model, 'custom/admin-nsfw-model');
    assert.equal(unsafe.resolved.profileId, nsfw);
  });
  await t.test('saved private profile assignments remain explicit overrides', async () => {
    assert.equal((await resolveStoryProviderForModel(custom, 'custom/own-sfw-model'))?.profileId, ownSfw);
    assert.equal((await resolveStudioNsfwProvider(custom))?.profileId, ownNsfw);
    await db.update(user).set({ preferences: { nsfwApiKeyId: nsfw } }).where(eq(user.id, fresh));
    assert.equal(await resolveStudioNsfwProvider(fresh), null, 'An arbitrary foreign profile ID is not an admin-default grant');
    await db.update(user).set({ preferences: {} }).where(eq(user.id, fresh));
  });
  await t.test('endpoint settings expose inherited model metadata, never admin profile IDs or credentials', async () => {
    const response = await app.request('/endpoints');
    assert.equal(response.status, 200);
    const result = await response.json() as { data: Record<string, unknown> };
    assert.deepEqual(result.data, { sfwApiKeyId: null, nsfwApiKeyId: null, defaults: {
      sfw: { provider: 'custom', model: 'custom/admin-sfw-model' }, nsfw: { provider: 'custom', model: 'custom/admin-nsfw-model' },
    } });
    const publicText = JSON.stringify(result);
    for (const privateValue of [admin, sfw, nsfw, secret.encrypted, 'admin-fixture-secret', 'admin-sfw.example']) assert.ok(!publicText.includes(privateValue));
    assert.equal((await db.select().from(apiKeys).where(eq(apiKeys.userId, member))).length, 0);
  });
  await t.test('the displayed Story default matches the inherited admin model without rewriting account preferences', async () => {
    const response = await app.request('/config');
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { selectedModel: string } }).data.selectedModel, 'custom/admin-sfw-model');
    assert.deepEqual((await db.select().from(user).where(eq(user.id, member)))[0]!.preferences, initial);
  });
  await t.test('a member cannot save another model or a mix while using the admin default', async () => {
    for (const patch of [{selectedModel:'custom/member-override'}, {mixMode:true}, {modelPool:[{modelId:'custom/member-override',weight:100}]}]) {
      const response = await app.request('/config', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
      assert.equal(response.status,403);
    }
    const response = await app.request('/config');
    const data = (await response.json() as {data:Record<string,unknown>}).data;
    assert.equal(data.adminDefaultModel,'custom/admin-sfw-model');
    assert.equal(data.mixMode,false);
    assert.deepEqual(data.modelPool,[]);
    assert.deepEqual((await db.select().from(user).where(eq(user.id, member)))[0]!.preferences,initial);
  });
  await t.test('shared provider calls pin the configured model after custom body shaping and strip fallback models', async t => {
    await db.update(apiKeys).set({metadata:{defaultModel:'admin-sfw-model',includeBody:{model:'body-override',models:['fallback-override']},excludeBody:['model']}}).where(eq(apiKeys.id,sfw));
    t.after(async()=>{await db.update(apiKeys).set({metadata:{defaultModel:'admin-sfw-model'}}).where(eq(apiKeys.id,sfw));});
    const sent: Array<Record<string,unknown>> = [];
    t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
      sent.push(JSON.parse(init.body as string));
      return new Response('data: {"choices":[{"delta":{"content":"Fixture response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
    });
    const resolved = await resolveStoryProviderForModel(member,'custom/request-override');assert.ok(resolved);
    for await (const _ of resolved.provider.generateStream({model:'custom/call-override',fallbackModels:['custom/fallback-override'],messages:[{role:'user',content:'Hello.'}]})) { /* consume */ }
    assert.equal(sent.length,1);
    assert.equal(sent[0]!.model,'admin-sfw-model');
    assert.equal(sent[0]!.models,undefined);
    const nsfwProvider = await resolveStudioNsfwProvider(member);assert.ok(nsfwProvider);
    for await (const _ of nsfwProvider.provider.generateStream({model:'custom/nsfw-call-override',fallbackModels:['custom/fallback-override'],messages:[{role:'user',content:'Hello.'}]})) { /* consume */ }
    assert.equal(sent[1]!.model,'admin-nsfw-model');
  });
  await t.test('personal profiles retain their own model choice', async () => {
    actor = custom;
    const response = await app.request('/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({selectedModel:'custom/personal-choice'})});
    assert.equal(response.status,200);
    const data = (await response.json() as {data:Record<string,unknown>}).data;
    assert.equal(data.selectedModel,'custom/personal-choice');
    assert.equal(data.adminDefaultModel,undefined);
    actor = member;
  });
  await t.test('upstream retries cannot remove the fixed model and invoke a provider default', async t => {
    const sent:Array<Record<string,unknown>>=[];
    t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
      sent.push(JSON.parse(init.body as string));
      return new Response('Unsupported parameter: model',{status:400});
    });
    const selected = await resolveStoryProviderForModel(member,'custom/request-override');assert.ok(selected);
    for await (const _ of selected.provider.generateStream({model:'custom/call-override',messages:[{role:'user',content:'Hello.'}]})) { /* consume */ }
    assert.ok(sent.length>0);
    assert.ok(sent.every(body=>body.model==='admin-sfw-model'));
  });
  await t.test('members neither receive the admin key nor can modify its profile', async () => {
    const listed = await app.request('/keys');
    assert.equal(listed.status,200);
    assert.deepEqual((await listed.json() as {data:unknown[]}).data,[]);
    const edited = await app.request('/keys/'+sfw,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({defaultModel:'foreign-override'})});
    assert.equal(edited.status,404);
    const text = await edited.text();
    for (const privateValue of [secret.encrypted,'admin-fixture-secret-never-public']) assert.ok(!text.includes(privateValue));
  });
  await t.test('clearing a personal assignment returns to the shared defaults', async () => {
    actor = custom;
    const response = await app.request('/endpoints', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sfwApiKeyId: null, nsfwApiKeyId: null }) });
    assert.equal(response.status, 200);
    assert.equal((await resolveStoryProviderForModel(custom, 'custom/client-placeholder'))?.model, 'custom/admin-sfw-model');
    assert.equal((await resolveStudioNsfwProvider(custom))?.model, 'custom/admin-nsfw-model');
    actor = member;
  });
  await t.test('admin model edits propagate to all inheriting accounts on the next resolution', async () => {
    await db.update(apiKeys).set({ metadata: { defaultModel: 'updated-admin-sfw-model' } }).where(eq(apiKeys.id, sfw));
    assert.equal((await resolveStoryProviderForModel(member, 'custom/old-default'))?.model, 'custom/updated-admin-sfw-model');
    assert.equal((await resolveStoryProviderForModel(fresh, 'custom/old-default'))?.model, 'custom/updated-admin-sfw-model');
  });
  await t.test('inherited provider HTTP errors cannot expose admin credentials or connection details', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('admin-fixture-secret-never-public https://admin-nsfw.example/v1 private-header-value', { status: 401 }));
    const resolved = await resolveStudioNsfwProvider(member);
    assert.ok(resolved);
    const chunks = [];
    for await (const chunk of resolved.provider.generateStream({model: resolved.model, messages: [{ role: 'user', content: 'Fixture' }]})) chunks.push(chunk);
    assert.ok(chunks.some(chunk => chunk.type === 'error'));
    const publicText = JSON.stringify(chunks);
    for (const privateValue of ['admin-fixture-secret-never-public', 'admin-nsfw.example', 'private-header-value']) assert.ok(!publicText.includes(privateValue));
  });
  await t.test('existing and new accounts repair state after an inherited endpoint rejects JSON mode', async t => {
    const sent: Array<Record<string, unknown>> = [];
    const batch = JSON.stringify({ narrative: '', status: 'updated', stateChanges: [{ variableId: 'energy', operation: 'subtract', value: 2 }] });
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string); sent.push(body);
      if (body.response_format) return new Response('400 response_format json_object is not supported admin-fixture-secret-never-public https://admin-nsfw.example/v1', { status: 400 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: batch }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const world = { id: 'guard-admin-fixture', version: '1.0.0', name: 'Guard fixture', description: '', author: 'test', entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 }, variables: [{ id: 'energy', name: 'Energy', type: 'number' as const, defaultValue: 100 }] };
    for (const owner of [member, fresh]) {
      const correction = await resolveGuardModel(owner, 'private::custom/client-placeholder', false);
      const state = new GameStateManager(world).getSnapshot();
      const audit: import('@yumina/shared').StateValidationAudit = { version: 1 as const, attemptId: crypto.randomUUID(), path: 'send' as const, outcome: 'validating' as const, diagnostics: [], parsedCount: 0, repaired: false, correctionCount: 0, model: correction.model, apiKeyTier: 'byok', startedAt: new Date().toISOString(), baselineFingerprint: 'test', usageLogIds: [] };
      const raw = 'You walk to the gate.';
      const result = await guardTurnOutput({ world, state, raw, parsed: new ResponseParser().parse(raw), ...correction, signal: new AbortController().signal, audit, history: [], mayCorrect: async () => true, progress: async () => {}, recordUsage: async () => 'isolated-usage', resolveCorrection: async () => ({ ...correction, contentRouting: undefined }) });
      assert.deepEqual(result.parsed.effects, [{ variableId: 'energy', operation: 'subtract', value: 2 }]);
      assert.equal(result.parsed.cleanText, raw);
      assert.equal(state.variables.energy, 100);
      assert.ok(audit.diagnostics.includes('provider_unsupported_format'));
      assert.equal(audit.correctionCount, 1);
      assert.equal(audit.usageLogIds.length, 1);
      assert.ok(!JSON.stringify(audit).includes('admin-fixture-secret-never-public'));
    }
    assert.equal(sent.length, 4);
    assert.ok(sent.every(body => body.model === 'updated-admin-sfw-model'));
    assert.equal(sent[1]!.response_format, undefined);
    assert.equal(sent[3]!.response_format, undefined);
  });
  await t.test('inherited transient errors retain Studio retry behavior without private diagnostics', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      if (++calls === 1) throw new Error('ECONNRESET admin-fixture-secret-never-public https://admin-nsfw.example/v1');
      return new Response('data: {"choices":[{"delta":{"content":"Fixture response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
    });
    const resolved = await resolveStudioNsfwProvider(member); assert.ok(resolved);
    const chunks = [];
    for await (const chunk of generateStreamWithRetry(resolved.provider, {model:resolved.model,messages:[{role:'user',content:'Fixture'}]}, 1)) chunks.push(chunk);
    assert.equal(calls, 2);
    assert.ok(chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Fixture response'));
    assert.ok(!JSON.stringify(chunks).includes('admin-fixture-secret'));
  });
  await t.test('editing NSFW while the shared SFW profile is invalid preserves SFW inheritance', async () => {
    actor = custom;
    await db.update(apiKeys).set({ metadata: {} }).where(eq(apiKeys.id, sfw));
    const response = await app.request('/endpoints', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nsfwApiKeyId: ownNsfw }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as {data:{sfwApiKeyId:string|null}}).data.sfwApiKeyId, null);
    assert.equal((await db.select().from(user).where(eq(user.id, custom)))[0]!.preferences?.activeApiKeyId, null);
    await db.update(apiKeys).set({metadata:{defaultModel:'updated-admin-sfw-model'}}).where(eq(apiKeys.id, sfw));
    assert.equal((await resolveStoryProviderForModel(custom, 'custom/placeholder'))?.profileId, sfw);
    actor = member;
  });
  await t.test('invalid shared NSFW configuration fails before any provider request', async () => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider request is permitted'); });
    await db.update(apiKeys).set({ metadata: {} }).where(eq(apiKeys.id, nsfw));
    assert.equal(await resolveStudioNsfwProvider(member), null);
  });
});
