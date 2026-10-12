import assert from 'node:assert/strict';
import test from 'node:test';
import type { MiddlewareHandler } from 'hono';
import { createImageSourceRoutes } from './image-sources.js';
import { createDanbooruClient, createDanbooruService, defaultDanbooruConfig, mergeDanbooruSettings, type DanbooruCredentials } from '../lib/image-sources/danbooru.js';
import type { DanbooruPublicConfig } from '../lib/image-sources/danbooru.js';
import type { AppEnv } from '../lib/types.js';
async function config(response: Response): Promise<DanbooruPublicConfig> { return (await response.json() as { config: DanbooruPublicConfig }).config; }
function setup(fail = false) {
  const rows = new Map<string, DanbooruCredentials>();
  const service = createDanbooruService({ async get(id) { return rows.get(id) ?? defaultDanbooruConfig(); },
    async update(id, input) { const next = mergeDanbooruSettings(rows.get(id) ?? defaultDanbooruConfig(), input); rows.set(id, next); return next; },
    async clear(id) { rows.delete(id); } }, async () => { throw new Error('unexpected import'); },
    createDanbooruClient(async () => fail ? new Response('secret upstream detail', { status: 401 }) : Response.json([])));
  const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = c.req.header('x-test-user');
    if (!id) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', { id } as AppEnv['Variables']['user']); await next();
  };
  return createImageSourceRoutes(service, auth);
}
test('settings routes protect each account, return frontend wrappers, preserve keys and clear explicitly', async () => {
  const routes = setup();
  const request = (method: string, body?: unknown, user = 'alice', path = '/danbooru') => routes.request(path, { method, headers: { 'x-test-user': user, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await routes.request('/danbooru')).status, 401);
  const initial = await request('GET'); assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await initial.json(), { config: { enabled: false, username: '', hasKey: false, configured: false } });
  let response = await request('PUT', { enabled: true, username: 'creator', apiKey: 'secret' });
  assert.deepEqual(await response.json(), { config: { enabled: true, username: 'creator', hasKey: true, configured: true } });
  response = await request('PUT', { enabled: true, username: 'creator', apiKey: '' }); assert.equal((await config(response)).hasKey, true);
  assert.equal((await config(await request('GET', undefined, 'bob'))).hasKey, false);
  assert.deepEqual(await (await request('POST', undefined, 'alice', '/danbooru/test')).json(), { success: true });
  assert.equal((await request('PUT', { enabled: true, username: 'other' })).status, 400);
  assert.equal((await request('PUT', { enabled: true, username: '', clearKey: true })).status, 200);
  assert.equal((await config(await request('GET'))).hasKey, false);
  await request('DELETE'); assert.equal((await config(await request('GET'))).enabled, false);
});
test('connection test and bad settings never return credentials or upstream error bodies', async () => {
  const routes = setup(true);
  const headers = { 'x-test-user': 'alice', 'content-type': 'application/json' };
  await routes.request('/danbooru', { method: 'PUT', headers, body: JSON.stringify({ enabled: true, username: 'creator', apiKey: 'secret' }) });
  const response = await routes.request('/danbooru/test', { method: 'POST', headers });
  const text = await response.text(); assert.equal(text.includes('secret'), false); assert.equal(JSON.parse(text).success, false);
  const rejected = await routes.request('/danbooru', { method: 'PUT', headers, body: JSON.stringify({ enabled: true, username: '', endpoint: 'http://localhost', apiKey: 'secret' }) });
  assert.equal(rejected.status, 400); assert.equal((await rejected.text()).includes('secret'), false);
});
