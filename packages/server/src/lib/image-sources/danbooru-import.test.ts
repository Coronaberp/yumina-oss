import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createDanbooruAssetStore, validateDanbooruRaster } from './danbooru-import.js';
import { normalizeDanbooruPost } from './danbooru.js';
const source = normalizeDanbooruPost({ id: 1, file_url: 'https://cdn.donmai.us/original/image.png', file_ext: 'png', rating: 'g', image_width: 10, image_height: 10 })!;
test('full raster decode accepts valid PNG and rejects SVG, HTML and truncated raster', async () => {
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#ff000080' } }).png().toBuffer();
  assert.deepEqual(await validateDanbooruRaster(png), { mimeType: 'image/png', extension: 'png', width: 2, height: 3 });
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), Buffer.from('<html>not an image</html>'), png.subarray(0, 30)]) await assert.rejects(validateDanbooruRaster(bad));
});
test('import validates actual bytes before persistence and preserves source attribution', async () => {
  let saved = false;
  const store = createDanbooruAssetStore({ configured: () => true, validate: validateDanbooruRaster,
    async persist(userId, bytes, post, info) { saved = true; assert.equal(userId, 'alice'); assert.ok(bytes.length); assert.equal(post.width, info.width); assert.match(post.attribution, /posts\/1/); return { id: 'owned', ref: '@asset:owned', filename: 'image.png', source: post }; } });
  await assert.rejects(store('alice', Buffer.from('not-image'), source)); assert.equal(saved, false);
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal((await store('alice', png, source)).ref, '@asset:owned'); assert.equal(saved, true);
});

test('transactional import saves without an account storage cap and replay reuses the existing owned asset', async () => {
  const { commitDanbooruAsset } = await import('./danbooru-import.js');
  type Asset = Awaited<ReturnType<typeof commitDanbooruAsset>>;
  let existing: Asset | undefined, writes = 0, registrations = 0;
  const bytes = Buffer.from('mock bytes after validated raster');
  const info = { mimeType: 'image/png', extension: 'png', width: 2, height: 3 };
  const transaction = { async existing() { return existing; },
    async write(key: string) { writes++; assert.match(key, /^users\/alice\/image\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/); },
    async register(asset: Asset) { registrations++; existing = asset; } };
  const first = await commitDanbooruAsset('alice', bytes, source, info, transaction, 'My landscape.webp');
  assert.equal(first.filename, 'My_landscape.png');
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const replay = await commitDanbooruAsset('alice', bytes, source, info, transaction);
  assert.deepEqual(replay, first); assert.equal(writes, 1); assert.equal(registrations, 1);
});
