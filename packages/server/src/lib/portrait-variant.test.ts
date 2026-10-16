import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createPortraitVariants } from './portrait-variant.js';

async function fixture() {
  const input = await sharp({ create: { width: 1254, height: 1254, channels: 4, background: '#934f2780' } }).png({ compressionLevel: 0 }).toBuffer();
  const objects = new Map<string, { buffer: Buffer; contentType: string; etag: string }>([['worlds/qa/portrait.png', { buffer: input, contentType: 'image/png', etag: 'v1' }]]);
  let reads = 0, writes = 0;
  const variants = createPortraitVariants({
    async head(key) { const object = objects.get(key); if (!object) throw new Error('Missing'); return { contentType: object.contentType, contentLength: object.buffer.length, etag: object.etag }; },
    async read(key) { reads++; const object = objects.get(key); if (!object) throw new Error('Missing'); return object; },
    async write(key, buffer, contentType) { writes++; objects.set(key, { buffer, contentType, etag: 'derived' }); },
  });
  return { variants, objects, input, get reads() { return reads; }, get writes() { return writes; } };
}

test('log portrait delivery reuses a tiny cached WebP without changing the full-resolution artwork', async () => {
  const f = await fixture();
  const keys = await Promise.all(Array.from({ length: 12 }, () => f.variants('worlds/qa/portrait.png')));
  assert.ok(keys[0]); assert.ok(keys.every(key => key === keys[0]));
  const thumb = f.objects.get(keys[0]!)!;
  assert.equal(thumb.contentType, 'image/webp');
  const meta = await sharp(thumb.buffer).metadata();
  assert.equal(meta.width, 128); assert.equal(meta.height, 128); assert.equal(meta.hasAlpha, true);
  assert.ok(thumb.buffer.length < f.input.length / 100);
  assert.equal(f.reads, 1); assert.equal(f.writes, 1);
  assert.equal(await f.variants('worlds/qa/portrait.png'), keys[0]);
  assert.equal(f.reads, 1); assert.equal(f.writes, 1);
  assert.deepEqual(f.objects.get('worlds/qa/portrait.png')!.buffer, f.input);
});

test('changed originals produce fresh thumbnails and deleted originals cannot reuse cached media', async () => {
  const f = await fixture(), first = await f.variants('worlds/qa/portrait.png');
  f.objects.get('worlds/qa/portrait.png')!.etag = 'v2';
  assert.notEqual(await f.variants('worlds/qa/portrait.png'), first);
  f.objects.delete('worlds/qa/portrait.png');
  assert.equal(await f.variants('worlds/qa/portrait.png'), undefined);
});

test('non-images, oversized originals, unsupported animations and storage failures keep their original path', async () => {
  const f = await fixture();
  f.objects.get('worlds/qa/portrait.png')!.contentType = 'video/mp4';
  assert.equal(await f.variants('worlds/qa/portrait.png'), undefined); assert.equal(f.reads, 0);
  const unavailable = createPortraitVariants({ head: async () => { throw new Error('Offline'); }, read: async () => { throw new Error('Offline'); }, write: async () => { throw new Error('Offline'); } });
  assert.equal(await unavailable('worlds/qa/portrait.png'), undefined);
  const pixels = Buffer.alloc(8 * 16 * 4, 120); pixels.fill(220, 8 * 8 * 4);
  const frames = await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ lossless: true, delay: [100, 200], loop: 0 }).toBuffer();
  assert.equal((await sharp(frames, { animated: true }).metadata()).pages, 2);
  f.objects.set('worlds/qa/animation.webp', { buffer: frames, contentType: 'image/webp', etag: 'animation' });
  assert.equal(await f.variants('worlds/qa/animation.webp'), undefined);
});
