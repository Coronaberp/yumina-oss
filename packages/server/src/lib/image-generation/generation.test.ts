import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { defaultGenerationConfig, mergeGenerationSettings, normalizeGenerationUrl, parseWorkflow, publicGenerationConfig, generationStatus, workflowWithPrompt,
  GenerationError, type GenerationRepository, type GeneratedAsset, type GeneratedSource } from './config.js';
import { ANIMA_BUILTIN_WORKFLOW } from './config.js';
import { createImageGenerationService, type GeneratedStorage } from './service.js';
import { generateComfyImage } from './comfyui.js';
import { generateForgeNeoImage } from './forgeneo.js';
import { combinedSignal, readBounded } from './transport.js';
import { normalizeGeneratedRaster, commitGeneratedAsset } from './asset-store.js';
import { IMAGE_GENERATION_DDL } from '../../db/image-generation-ddl.js';
import { createImageGenerationRoutes } from '../../routes/image-generation.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
const workflow = JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['2',0] } }, '2': { class_type: 'SaveImage', inputs: { images: ['3',0] } } });
function repository(): GenerationRepository {
  let state = defaultGenerationConfig();
  return { get: async () => structuredClone(state), update: async (_, input) => state = mergeGenerationSettings(state, input, true),
    clear: async (_, provider) => { state.configs[provider] = defaultGenerationConfig().configs[provider]; return structuredClone(state); } };
}
const source: GeneratedSource = { provider: 'forgeneo', imageKind: 'sprite', prompt: 'character', attribution: 'test', greenRemoved: true, createdAt: '2026-10-04T00:00:00Z' };
const saved: GeneratedAsset = { id: 'abcd', ref: '@asset:abcd', filename: 'image.png', source };
function storage(): GeneratedStorage { return { preflight: async () => {}, validate: async () => {}, save: async (_, __, metadata) => ({ ...saved, source: metadata }) }; }
async function configuredRepository() {
  const repo = repository();
  await repo.update('u', { provider: 'comfyui', enabled: true, baseUrl: 'http://127.0.0.1:8188', workflow });
  await repo.update('u', { provider: 'forgeneo', enabled: true, baseUrl: 'http://127.0.0.1:7860', model: 'checkpoint.safetensors', apiKey: 'neo:secret' });
  return repo;
}
function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url, init) => handler(new URL(String(url)), init)) as typeof fetch;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function service(repo: GenerationRepository, store: GeneratedStorage, fetcher: typeof fetch, extras: Partial<Parameters<typeof createImageGenerationService>[0]> = {}) {
  return createImageGenerationService({ repository: repo, storage: store, fetch: fetcher, buildGreenScreenPrompt: prompt => prompt + ', green_background',
    removeGreenBackground: async bytes => bytes, pollDelayMs: 1, ...extras });
}
test('generic ComfyUI and Forge transparency processing passes the untouched provider source to storage', async t => {
  for (const provider of ['comfyui', 'forgeneo'] as const) await t.test(provider, async () => {
    const original = Buffer.from('untouched provider output with metadata');
    const derivative = Buffer.from('explicit transparency derivative');
    let stored = false;
    const store = storage();
    store.save = async (_owner, bytes, metadata, _signal, artifacts) => {
      stored = true;
      assert.deepEqual(bytes, derivative);
      assert.deepEqual(artifacts?.originalBytes, original);
      assert.equal(metadata.greenRemoved, true);
      return { ...saved, source: metadata };
    };
    const engine = service(await configuredRepository(), store, mockFetch(url => {
      if (url.pathname === '/sdapi/v1/txt2img') return json({ images: [original.toString('base64')] });
      if (url.pathname === '/prompt') return json({ prompt_id: 'job' });
      if (url.pathname.startsWith('/history')) return json({ job: { status: { completed: true }, outputs: {
        x: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } });
      return new Response(original.toString());
    }), { removeGreenBackground: async bytes => { assert.deepEqual(bytes, original); return derivative; } });
    await engine.generate('u', { provider, prompt: 'isolated character', imageKind: 'sprite', transparent: true });
    assert.equal(stored, true);
  });
});
test('ComfyUI settings select the built-in Anima mode while preserving a return path to custom workflows', () => {
  let state = mergeGenerationSettings(defaultGenerationConfig(), { provider: 'comfyui', enabled: true,
    baseUrl: 'http://127.0.0.1:8188', workflowMode: 'anima' }, true);
  assert.equal(state.configs.comfyui.workflow, ANIMA_BUILTIN_WORKFLOW);
  assert.equal(publicGenerationConfig(state).configs.comfyui.workflowMode, 'anima');
  assert.equal(publicGenerationConfig(state).configs.comfyui.workflow, '');
  assert.equal(generationStatus(state).configs.comfyui.workflowSummary, 'Anima VN sprite pipeline');
  assert.equal(state.configs.comfyui.enabled, true);
  state = mergeGenerationSettings(state, { provider: 'comfyui', enabled: true, baseUrl: 'http://127.0.0.1:8188',
    workflowMode: 'custom', workflow }, true);
  assert.equal(state.configs.comfyui.workflow, workflow);
  assert.equal(publicGenerationConfig(state).configs.comfyui.workflowMode, 'custom');
});
test('independent profiles, active selection, blank-auth preservation and public redaction', () => {
  let state = defaultGenerationConfig();
  state = mergeGenerationSettings(state, { provider: 'forgeneo', enabled: true, baseUrl: 'http://127.0.0.1:7860', apiKey: 'neo:secret', makeActive: true }, true);
  state = mergeGenerationSettings(state, { provider: 'comfyui', enabled: true, baseUrl: 'http://127.0.0.1:8188', workflow, apiKey: 'comfysecret' }, true);
  state = mergeGenerationSettings(state, { provider: 'forgeneo', enabled: true, baseUrl: 'http://127.0.0.1:7860', apiKey: '' }, true);
  assert.equal(state.activeProvider, 'forgeneo'); assert.equal(state.configs.forgeneo.apiKey, 'neo:secret');
  assert.equal(publicGenerationConfig(state).configs.comfyui.workflow, workflow);
  const status = JSON.stringify(generationStatus(state));
  assert.ok(!status.includes('secret') && !status.includes('127.0.0.1') && !status.includes('CLIPTextEncode'));
  state = mergeGenerationSettings(state, { provider: 'forgeneo', enabled: false, baseUrl: 'http://127.0.0.1:7860', clearKey: true }, true);
  assert.equal(state.configs.forgeneo.apiKey, null); assert.equal(state.configs.comfyui.apiKey, 'comfysecret');
});
test('URL policy allows explicit local ComfyUI and Forge Neo and rejects credential injection or metadata', () => {
  assert.equal(normalizeGenerationUrl('http://localhost:8188/proxy/', 'comfyui', true), 'http://localhost:8188/proxy');
  assert.equal(normalizeGenerationUrl('http://localhost:7860/', 'forgeneo', true), 'http://localhost:7860');
  for (const url of ['file:///tmp/x', 'http://u:p@localhost:8188', 'http://169.254.169.254', 'http://metadata', 'http://localhost:8188/?key=secret'])
    assert.throws(() => normalizeGenerationUrl(url, 'comfyui'), GenerationError);
  assert.throws(() => normalizeGenerationUrl('http://localhost:7860', 'forgeneo', false), GenerationError);
  assert.throws(() => mergeGenerationSettings({ ...defaultGenerationConfig(), configs: { ...defaultGenerationConfig().configs, forgeneo: { ...defaultGenerationConfig().configs.forgeneo, apiKey: 'neo:secret' } } },
    { provider: 'forgeneo', enabled: true, baseUrl: 'https://another.example' }), /Replace or clear/);
});
test('workflow replaces only string input values safely, rejects editor export or absent slot', () => {
  const prompt = 'portrait "quote"\n{{prompt}}';
  const resolved = workflowWithPrompt(workflow, prompt);
  assert.equal((resolved['1'] as { inputs: { text: string } }).inputs.text, prompt);
  assert.throws(() => parseWorkflow(JSON.stringify({ nodes: [] })), GenerationError);
  assert.throws(() => parseWorkflow(JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed' } } })), /Add/);
});
test('ComfyUI queue polls only its history and retrieves safely encoded same-origin output', async () => {
  const calls: string[] = []; let polls = 0;
  const profile = { ...defaultGenerationConfig().configs.comfyui, workflow, apiKey: 'proxy-key' };
  const result = await generateComfyImage(profile, '1girl, portrait', combinedSignal(undefined, 1000), { pollDelayMs: 1, fetch: mockFetch((url, init) => {
    calls.push(url.href); assert.equal(url.origin, 'http://127.0.0.1:8188'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer proxy-key');
    if (url.pathname === '/prompt') {
      const body = JSON.parse(String(init?.body)) as { prompt: { '1': { inputs: { text: string } } }; client_id: string };
      assert.equal(body.prompt['1'].inputs.text, '1girl, portrait'); assert.match(body.client_id, /^[0-9a-f-]{36}$/); return json({ prompt_id: 'my-job' });
    }
    if (url.pathname.startsWith('/history')) { polls++; return json(polls === 1 ? {} : { 'other-job': { outputs: { x: { images: [{ filename: 'wrong.png' }] } } }, 'my-job': { status: { completed: true, status_str: 'success' }, outputs: { x: { images: [{ filename: 'hello & world.png', subfolder: 'characters/day', type: 'output' }] } } } }); }
    assert.equal(url.searchParams.get('filename'), 'hello & world.png'); assert.equal(url.searchParams.get('subfolder'), 'characters/day'); return new Response('pixels');
  }) });
  assert.equal(result.bytes.toString(), 'pixels'); assert.equal(result.promptId, 'my-job'); assert.equal(calls.length, 4);
});
test('ComfyUI rejects execution errors and provider-supplied paths without calling view', async () => {
  const profile = { ...defaultGenerationConfig().configs.comfyui, workflow };
  for (const entry of [ { status: { status_str: 'error', completed: false }, outputs: {} },
    { status: { completed: true }, outputs: { x: { images: [{ filename: '../secret.png', subfolder: '', type: 'output' }] } } },
    { status: { completed: true }, outputs: { x: { images: [{ filename: 'x.png', subfolder: '/etc', type: 'input' }] } } } ]) {
    let calls = 0;
    await assert.rejects(generateComfyImage(profile, 'p', combinedSignal(undefined, 1000), { fetch: mockFetch(url => { calls++; return url.pathname === '/prompt' ? json({ prompt_id: 'job' }) : json({ job: entry }); }) }), GenerationError);
    assert.equal(calls, 2);
  }
});
test('Forge Neo sends native txt2img JSON, portrait dimensions and optional checkpoint override', async () => {
  const profile = { ...defaultGenerationConfig().configs.forgeneo, model: 'checkpoint.safetensors', apiKey: 'neo:secret' };
  const bytes = await generateForgeNeoImage(profile, '1girl, smiling character', 'sprite', combinedSignal(), mockFetch((url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:7860/sdapi/v1/txt2img');
    assert.equal((init?.headers as Record<string,string>).Authorization, `Basic ${Buffer.from('neo:secret').toString('base64')}`);
    const body = JSON.parse(String(init?.body)) as Record<string,unknown>;
    assert.equal(body.width, 1024); assert.equal(body.height, 1536); assert.equal(body.prompt, '1girl, smiling character');
    assert.equal(body.batch_size, 1); assert.equal(body.n_iter, 1); assert.equal(body.save_images, false);
    assert.deepEqual(body.override_settings, { sd_model_checkpoint: 'checkpoint.safetensors' }); assert.equal(body.override_settings_restore_afterwards, true);
    return json({ images: [Buffer.from('png').toString('base64')] });
  }));
  assert.equal(bytes.toString(), 'png');
});
test('Forge Neo rejects URL-only image output without downloading that URL', async () => {
  let calls = 0;
  await assert.rejects(generateForgeNeoImage(defaultGenerationConfig().configs.forgeneo, 'p', 'image', combinedSignal(), mockFetch(() => { calls++; return json({ images: ['http://169.254.169.254/key'] }); })), /base64/);
  assert.equal(calls, 1);
});
test('Forge Neo backgrounds request landscape dimensions', async () => {
  await generateForgeNeoImage(defaultGenerationConfig().configs.forgeneo, 'A forest scene.', 'background', combinedSignal(), mockFetch((_, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.width, 1536); assert.equal(body.height, 1024);
    return json({ images: ['cG5n'] });
  }));
});
test('bounded body and abort stop reading provider responses', async () => {
  await assert.rejects(readBounded(new Response('12345'), 4, combinedSignal()), /size limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readBounded(new Response('x'), 10, controller.signal));
});
test('ComfyUI and Forge Neo sprites remove green; backgrounds do not', async () => {
  const repo = await configuredRepository(); let greens = 0; const sent: string[] = [];
  const engine = service(repo, storage(), mockFetch((url, init) => {
    if (url.pathname === '/sdapi/v1/txt2img') { sent.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt); return json({ images: ['cG5n'] }); }
    if (url.pathname === '/prompt') { sent.push((JSON.parse(String(init?.body)) as { prompt: { '1': { inputs: { text: string } } } }).prompt['1'].inputs.text); return json({ prompt_id: 'job' }); }
    if (url.pathname.startsWith('/history')) return json({ job: { status: { completed: true }, outputs: { x: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } });
    return new Response('pixels');
  }), { removeGreenBackground: async bytes => { greens++; return bytes; }, now: (() => { let time = 0; return () => time += 20_000; })() });
  const sprite = await engine.generate('u', { provider: 'comfyui', prompt: '1girl', imageKind: 'sprite', transparent: true });
  await engine.generate('u', { provider: 'comfyui', prompt: 'forest', imageKind: 'background' });
  const forge = await engine.generate('u', { provider: 'forgeneo', prompt: '1girl, smiling person', imageKind: 'sprite', transparent: true });
  await engine.generate('u', { provider: 'forgeneo', prompt: 'forest', imageKind: 'background' });
  assert.equal(greens, 2); assert.deepEqual(sent, ['1girl, green_background', 'forest', '1girl, smiling person, green_background', 'forest']);
  assert.equal(sprite.source.greenRemoved, true); assert.equal(forge.source.greenRemoved, true);
  assert.ok(!JSON.stringify(sprite.source).includes('127.0.0.1'));
});
test('abort during ComfyUI polling deletes that queued prompt and interrupts only that prompt', async () => {
  const controller = new AbortController(); let stored = false; const paths: string[] = [];
  const store = storage(); store.save = async () => { stored = true; return saved; };
  const engine = service(await configuredRepository(), store, mockFetch((url, init) => { paths.push(url.pathname); if (url.pathname === '/prompt') return json({ prompt_id: 'job' });
    if (url.pathname === '/history/job') { controller.abort(); return json({}); }
    if (url.pathname === '/queue') assert.deepEqual(JSON.parse(String(init?.body)), { delete: ['job'] });
    if (url.pathname === '/interrupt') assert.deepEqual(JSON.parse(String(init?.body)), { prompt_id: 'job' });
    return json({}); }));
  await assert.rejects(engine.generate('u', { prompt: '1girl', imageKind: 'sprite', signal: controller.signal }), (error: unknown) => error instanceof GenerationError && error.code === 'ABORTED');
  assert.equal(stored, false); assert.deepEqual(paths, ['/prompt', '/history/job', '/queue', '/interrupt']);
});
test('unavailable storage preflight fails before any paid provider call', async () => {
  let calls = 0; const store = storage(); store.preflight = async () => { throw new GenerationError('STORAGE_UNAVAILABLE', 'storage unavailable', 503); };
  const engine = service(await configuredRepository(), store, mockFetch(() => { calls++; return json({}); }));
  await assert.rejects(engine.generate('u', { provider: 'forgeneo', prompt: 'p', imageKind: 'image' }), /storage unavailable/); assert.equal(calls, 0);
});
test('durable request replay returns owned asset and failed/pending confirmation never calls provider', async () => {
  let calls = 0; const store = storage();
  store.findRequest = async () => saved;
  const engine = service(await configuredRepository(), store, mockFetch(() => { calls++; return json({}); }));
  assert.deepEqual(await engine.generate('u', { prompt: 'p', imageKind: 'image', requestId: 'confirmed-1' }), saved);
  store.findRequest = async () => undefined; store.claimRequest = async () => { throw new GenerationError('REQUEST_ALREADY_SUBMITTED', 'already submitted', 409); };
  await assert.rejects(engine.generate('u', { prompt: 'p', imageKind: 'image', requestId: 'confirmed-1' }), /already submitted/); assert.equal(calls, 0);
});
test('generated raster validates actual bytes, strips embedded workflow metadata and preserves alpha', async () => {
  const original = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().withMetadata().toBuffer();
  const output = await normalizeGeneratedRaster(original, combinedSignal());
  assert.equal(output.width, 2); assert.equal((await sharp(output.bytes).metadata()).hasAlpha, true); assert.equal((await sharp(output.bytes).metadata()).exif, undefined);
  await assert.rejects(normalizeGeneratedRaster(Buffer.from('<svg></svg>'), combinedSignal()), /raster/);
});
test('sprite delivery requires a real transparent PNG while opaque backgrounds remain valid', async () => {
  const opaque = sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 50, g: 20, b: 30, alpha: 1 } } });
  await assert.rejects(normalizeGeneratedRaster(await opaque.clone().png().toBuffer(), combinedSignal(), true), /opaque sprite/);
  await assert.rejects(normalizeGeneratedRaster(await opaque.clone().jpeg().toBuffer(), combinedSignal(), true), /opaque sprite/);
  assert.equal((await normalizeGeneratedRaster(await opaque.clone().png().toBuffer(), combinedSignal())).width, 2);
  const transparent = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 50, g: 20, b: 30, alpha: 0 } } }).png().toBuffer();
  assert.equal((await normalizeGeneratedRaster(transparent, combinedSignal(), true)).width, 2);
});
test('generated asset registration has no account storage cap and abort prevents registration', async () => {
  let writes = 0; let registrations = 0;
  const controller = new AbortController();
  const tx = { write: async () => { writes++; }, register: async () => { registrations++; } };
  const asset = await commitGeneratedAsset('u', Buffer.from('12'), source, tx, controller.signal);
  assert.match(asset.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(writes, 1); assert.equal(registrations, 1);
  tx.write = async () => { controller.abort(); };
  await assert.rejects(commitGeneratedAsset('u', Buffer.from('1'), source, tx, controller.signal));
  assert.equal(registrations, 1);
});
test('generated sprite bundles persist the untouched source and link it from the final asset', async () => {
  const bundleApi = await import('./asset-store.js') as unknown as { commitGeneratedAssetBundle?: (
    userId: string, finalBytes: Buffer, source: GeneratedSource, original: { bytes: Buffer; source: GeneratedSource },
    tx: { write(key: string, bytes: Buffer, signal: AbortSignal): Promise<void>; register(asset: GeneratedAsset, key: string, bytes: number): Promise<void> }, signal: AbortSignal,
  ) => Promise<GeneratedAsset> };
  assert.equal(typeof bundleApi.commitGeneratedAssetBundle, 'function');
  const assets: GeneratedAsset[] = [];
  const result = await bundleApi.commitGeneratedAssetBundle!('u', Buffer.from('transparent'), source,
    { bytes: Buffer.from('original'), source: { ...source, imageKind: 'image' } },
    { write: async () => {}, register: async asset => { assets.push(asset); } }, combinedSignal());
  assert.equal(assets.length, 2);
  assert.equal(assets[0]!.source.assetRole, 'original');
  assert.equal(assets[1]!.source.assetRole, 'final');
  assert.equal(result.source.originalAssetId, assets[0]!.id);
  assert.equal(result.id, assets[1]!.id);
});
test('settings routes return exact two-profile contract and Forge Neo tests are read-only', async () => {
  const repo = repository(); const paths: string[] = [];
  const engine = service(repo, storage(), mockFetch(url => { paths.push(url.pathname); return json({ sd_model_checkpoint: 'checkpoint.safetensors' }); }));
  const auth: MiddlewareHandler<AppEnv> = async (c, next) => { c.set('user', { id: 'u' } as AppEnv['Variables']['user']); await next(); };
  const app = createImageGenerationRoutes(engine, auth);
  let response = await app.request('/generation'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const initial = await response.json() as { activeProvider: string; configs: Record<string,unknown> }; assert.equal(initial.activeProvider, 'comfyui'); assert.equal(Object.keys(initial.configs).length, 2);
  response = await app.request('/generation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'forgeneo', enabled: true, baseUrl: 'http://127.0.0.1:7860', apiKey: 'neo:TOPSECRET', makeActive: true }) });
  const text = await response.text(); assert.equal(response.status, 200); assert.ok(!text.includes('TOPSECRET')); assert.ok(text.includes('"activeProvider":"forgeneo"'));
  response = await app.request('/generation/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'forgeneo' }) });
  assert.deepEqual(await response.json(), { success: true }); assert.deepEqual(paths, ['/sdapi/v1/options']);
  response = await app.request('/generation/forgeneo', { method: 'DELETE' });
  const deleted = await response.json() as { configs: { forgeneo: { hasKey: boolean; enabled: boolean } } }; assert.equal(deleted.configs.forgeneo.hasKey, false); assert.equal(deleted.configs.forgeneo.enabled, false);
});
test('settings test redacts upstream error body and invalid settings never echo input', async () => {
  const engine = service(await configuredRepository(), storage(), mockFetch(() => new Response('SECRET upstream trace', { status: 401 })));
  const auth: MiddlewareHandler<AppEnv> = async (c, next) => { c.set('user', { id: 'u' } as AppEnv['Variables']['user']); await next(); };
  const app = createImageGenerationRoutes(engine, auth);
  const response = await app.request('/generation/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'forgeneo' }) });
  const text = await response.text(); assert.ok(text.includes('false')); assert.ok(!text.includes('SECRET'));
  const invalid = await app.request('/generation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'other', apiKey: 'SECRET' }) });
  assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes('SECRET'));
});
test('DDL works in isolated memory database: separate encrypted profiles, credentials tuple and replay uniqueness', async () => {
  const database = new PGlite();
  try {
    await database.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE user_assets (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'u\');');
    for (const ddl of IMAGE_GENERATION_DDL) await database.exec(ddl);
    for (const ddl of IMAGE_GENERATION_DDL) await database.exec(ddl);
    await database.exec("INSERT INTO user_image_generation_settings(user_id,provider,base_url) VALUES('u','comfyui','http://localhost:8188'),('u','forgeneo','http://localhost:7860');");
    const count = await database.query<{ count: number }>('SELECT count(*)::integer as count FROM user_image_generation_settings'); assert.equal(count.rows[0]!.count, 2);
    await assert.rejects(database.exec("UPDATE user_image_generation_settings SET encrypted_key='key' WHERE provider='forgeneo'"));
    await assert.rejects(database.exec("INSERT INTO user_image_generation_settings(user_id,provider,base_url) VALUES('u','openai','https://api.openai.com/v1')"));
    await database.exec("INSERT INTO image_generation_requests(user_id,request_id,state) VALUES('u','confirmation','pending')");
    await assert.rejects(database.exec("INSERT INTO image_generation_requests(user_id,request_id,state) VALUES('u','confirmation','pending')"));
    await database.exec('DELETE FROM "user" WHERE id=\'u\'');
    assert.equal((await database.query('SELECT * FROM image_generation_requests')).rows.length, 0);
  } finally { await database.close(); }
});

test('unreadable credentials stay visible as saved, disable configuration and can be replaced independently', () => {
  const state = defaultGenerationConfig();
  state.configs.forgeneo = { ...state.configs.forgeneo, enabled: true, keyUnreadable: true };
  state.configs.comfyui = { ...state.configs.comfyui, enabled: true, workflow, keyUnreadable: true };
  const config = publicGenerationConfig(state);
  assert.equal(config.configs.forgeneo.hasKey, true); assert.equal(config.configs.forgeneo.configured, false);
  assert.equal(config.configs.comfyui.hasKey, true); assert.equal(config.configs.comfyui.configured, false);
  assert.throws(() => mergeGenerationSettings(state, { provider: 'forgeneo', enabled: true, baseUrl: state.configs.forgeneo.baseUrl }, true), /Clear or replace/);
  const replacement = mergeGenerationSettings(state, { provider: 'forgeneo', enabled: true, baseUrl: state.configs.forgeneo.baseUrl, apiKey: 'neo:replacement' }, true);
  assert.equal(replacement.configs.forgeneo.keyUnreadable, false); assert.equal(replacement.configs.comfyui.keyUnreadable, true);
});
test('generation timeout stops pending ComfyUI history and does not store an image', async () => {
  let stored = false;
  const store = storage(); store.save = async () => { stored = true; return saved; };
  const engine = service(await configuredRepository(), store, mockFetch(url => url.pathname === '/prompt' ? json({ prompt_id: 'job' }) : json({})), { timeoutMs: 10, pollDelayMs: 2 });
  await assert.rejects(engine.generate('u', { prompt: '1girl', imageKind: 'sprite' }), (error: unknown) => error instanceof GenerationError && error.code === 'TIMEOUT');
  assert.equal(stored, false);
});
test('same-account concurrent generations are denied and failure releases the active slot', async () => {
  const repo = await configuredRepository(); let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const engine = service(repo, storage(), mockFetch(async () => { calls++; if (calls === 1) await gate; return json({ images: ['cG5n'] }); }));
  const first = engine.generate('u', { provider: 'forgeneo', prompt: 'p', imageKind: 'image' });
  // Allow the first generation to enter the mocked provider.
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(engine.generate('u', { provider: 'forgeneo', prompt: 'q', imageKind: 'image' }), (error: unknown) => error instanceof GenerationError && error.code === 'GENERATION_BUSY');
  release!(); await first;
  await engine.generate('u', { provider: 'forgeneo', prompt: 'r', imageKind: 'image' });
  assert.equal(calls, 2);
});


test('generated storage uses lossless WebP when smaller with matching key, filename, MIME, dimensions and transparent RGB', async () => {
  const width = 64, height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 12; pixels[i + 1] = 34; pixels[i + 2] = 56; pixels[i + 3] = i % 8 ? 255 : 0;
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const image = await normalizeGeneratedRaster(input, combinedSignal());
  assert.equal((await sharp(image.bytes).metadata()).format, 'webp');
  assert.ok(image.bytes.length < input.length);
  assert.deepEqual(await sharp(image.bytes).raw().toBuffer(), pixels);
  assert.equal(image.width, width); assert.equal(image.height, height);
  let writtenMime: string | undefined, registeredMime: string | undefined, registeredSize: number | undefined;
  let writtenKey = '';
  const asset = await commitGeneratedAsset('u', image.bytes, source, {
    async write(key, bytes, _signal, mimeType) { writtenKey = key; writtenMime = mimeType; assert.deepEqual(bytes, image.bytes); },
    async register(asset, key, bytes, mimeType) { assert.equal(key, writtenKey); registeredMime = mimeType; registeredSize = bytes; },
  }, combinedSignal());
  assert.match(asset.filename, /\.webp$/); assert.match(writtenKey, /\.webp$/);
  assert.equal(writtenMime, 'image/webp'); assert.equal(registeredMime, 'image/webp'); assert.equal(registeredSize, image.bytes.length);
});
