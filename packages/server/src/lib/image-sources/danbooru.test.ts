import assert from 'node:assert/strict';
import test from 'node:test';
import { createDanbooruClient, createDanbooruService, defaultDanbooruConfig, mergeDanbooruSettings,
  publicDanbooruConfig, normalizeDanbooruPost, safeDanbooruImageUrl, readBoundedResponse,
  DANBOORU_MAX_BYTES, type DanbooruRepository } from './danbooru.js';
const anon = { enabled: true, username: '', apiKey: null };
const credentials = { enabled: true, username: 'creator', apiKey: 'secret' };
const fixture = { id: 7, file_url: 'https://cdn.donmai.us/original/ab/cd/image.png', preview_file_url: 'https://cdn.donmai.us/preview/ab/cd/image.jpg',
  file_ext: 'png', image_width: 640, image_height: 480, rating: 'g', source: 'https://artist.example/art', tag_string: 'landscape scenery', tag_string_artist: 'artist' };
export function memoryRepository(): DanbooruRepository {
  const rows = new Map<string, typeof credentials | typeof anon>();
  return { async get(id) { return rows.get(id) ?? defaultDanbooruConfig(); },
    async update(id, input) { const next = mergeDanbooruSettings(rows.get(id) ?? defaultDanbooruConfig(), input); rows.set(id, next); return next; },
    async clear(id) { rows.delete(id); } };
}
test('settings default disabled; anonymous works; saved keys stay private and blank preserves them', () => {
  assert.equal(publicDanbooruConfig(defaultDanbooruConfig()).configured, false);
  assert.equal(publicDanbooruConfig(anon).configured, true);
  const saved = mergeDanbooruSettings(credentials, { enabled: false, username: 'creator', apiKey: '' });
  assert.equal(saved.apiKey, 'secret');
  assert.deepEqual(publicDanbooruConfig(saved), { enabled: false, username: 'creator', hasKey: true, configured: false });
  assert.equal(JSON.stringify(publicDanbooruConfig(credentials)).includes('secret'), false);
  assert.throws(() => mergeDanbooruSettings(credentials, { enabled: true, username: 'other' }));
  assert.throws(() => mergeDanbooruSettings(anon, { enabled: true, username: 'creator' }));
  assert.deepEqual(mergeDanbooruSettings(credentials, { enabled: true, username: '', clearKey: true }), anon);
});
test('metadata only allows the exact CDN, supported raster and public HTTP attribution', () => {
  for (const url of ['http://cdn.donmai.us/original/a.jpg', 'https://cdn.donmai.us.evil/original/a.jpg',
    'https://127.0.0.1/original/a.jpg', 'https://x:secret@cdn.donmai.us/original/a.jpg',
    'https://cdn.donmai.us:8443/original/a.jpg', 'https://cdn.donmai.us/original/a.svg',
    'https://cdn.donmai.us/original/a.jpg?secret=1']) assert.equal(safeDanbooruImageUrl(url), null);
  const post = normalizeDanbooruPost(fixture)!;
  assert.equal(post.postId, 7); assert.match(post.attribution, /artist.*posts\/7/);
  assert.equal(normalizeDanbooruPost({ ...fixture, source: 'javascript:alert(1)' })?.sourceUrl, null);
  for (const extra of [{ is_deleted: true }, { is_banned: true }, { file_ext: 'zip' }, { image_width: 100000 }, { id: '7' }]) assert.equal(normalizeDanbooruPost({ ...fixture, ...extra }), null);
});
test('search is fixed host, bounded, defaults general rating and puts Basic auth only in header', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createDanbooruClient(async (url, init) => { requests.push({ url: String(url), init }); return Response.json([fixture]); });
  const result = await client.search(credentials, { tags: 'scenery', limit: 20 });
  assert.equal(result[0]!.postId, 7);
  assert.equal(new URL(requests[0]!.url).origin, 'https://danbooru.donmai.us');
  assert.equal(new URL(requests[0]!.url).searchParams.get('tags'), 'scenery rating:general');
  assert.equal(requests[0]!.url.includes('secret'), false);
  assert.equal((requests[0]!.init?.headers as Record<string,string>).Authorization, 'Basic ' + Buffer.from('creator:secret').toString('base64'));
  assert.equal(requests[0]!.init?.redirect, 'error');
  await assert.rejects(client.search(anon, { tags: 'scenery', limit: 21 }));
  await client.search(anon, { tags: 'scenery rating:safe' });
  assert.equal((requests.at(-1)?.init?.headers as Record<string,string>).Authorization, undefined);
});
test('import reads post by integer ID, never sends credentials to CDN and rejects arbitrary URLs', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createDanbooruClient(async (url, init) => {
    requests.push({ url: String(url), init });
    return requests.length === 1 ? Response.json(fixture) : new Response('raster fixture', { headers: { 'content-type': 'image/png' } });
  });
  const downloaded = await client.download(credentials, 7);
  assert.equal(downloaded.post.pageUrl, 'https://danbooru.donmai.us/posts/7');
  assert.equal((requests[1]!.init?.headers as Record<string,string>).Authorization, undefined);
  assert.equal(requests[1]!.init?.redirect, 'error');
  await assert.rejects(client.download(anon, NaN)); await assert.rejects(client.download(anon, 1.2));
  const malicious = createDanbooruClient(async () => Response.json({ ...fixture, file_url: 'http://localhost/internal.png' }));
  await assert.rejects(malicious.download(anon, 7), /supported downloadable image/);
});
test('bounded response rejects content length and overflowing streams before storage', async () => {
  await assert.rejects(readBoundedResponse(new Response('x', { headers: { 'content-length': String(DANBOORU_MAX_BYTES + 1) } }), DANBOORU_MAX_BYTES));
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); }, cancel() { canceled = true; } });
  await assert.rejects(readBoundedResponse(new Response(stream), 8)); assert.equal(canceled, true);
});
test('upstream/network errors are redacted and disabled configuration blocks every external request', async () => {
  const failed = createDanbooruClient(async () => new Response('secret provider detail', { status: 401 }));
  await assert.rejects(failed.test(credentials), error => error instanceof Error && !error.message.includes('secret'));
  const network = createDanbooruClient(async () => { throw new Error('secret'); });
  await assert.rejects(network.test(credentials), error => error instanceof Error && !error.message.includes('secret'));
  const repository = memoryRepository(); let calls = 0, stores = 0;
  const service = createDanbooruService(repository, async (_id, _bytes, source) => { stores++; return { id: 'owned', ref: '@asset:owned', filename: 'asset.png', source }; },
    createDanbooruClient(async () => { calls++; return calls === 1 ? Response.json(fixture) : new Response('image', { headers: { 'content-type': 'image/png' } }); }));
  await assert.rejects(service.search('alice', { tags: 'landscape' })); assert.equal(calls, 0);
  await service.updateConfig('alice', { enabled: true, username: '' });
  const imported = await service.import('alice', 7); assert.equal(imported.ref, '@asset:owned'); assert.equal(stores, 1);
  assert.equal((await service.getConfig('bob')).enabled, false);
  await service.clearConfig('alice'); assert.equal((await service.getConfig('alice')).enabled, false);
});
