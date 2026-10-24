import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../db/index.js';
import { IMAGE_MASTERS_DDL } from '../../db/image-masters-ddl.js';
import { getObjectBuffer, headObject, getLocalDiskStorage } from '../s3.js';
import { generatedImageStorage } from './storage.js';
import type { GeneratedAsset, GeneratedSource } from './config.js';
import { validateGeneratedRaster } from './asset-store.js';
import { imageMasters } from '../image-masters.js';

const signal = () => AbortSignal.timeout(20_000);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const source: GeneratedSource = { provider: 'comfyui', imageKind: 'background', prompt: 'fixture',
  attribution: 'isolated fixture', createdAt: '2026-10-24T00:00:00Z', greenRemoved: false };
type Saved = { url: string; mime_type: string; size_bytes: number; metadata: GeneratedSource };
async function readAsset(asset: GeneratedAsset): Promise<Saved> {
  const result = await db.execute(sql`SELECT a.url,a.mime_type,a.size_bytes,s.metadata FROM user_assets a
    JOIN generated_image_sources s ON s.asset_id=a.id WHERE a.id=${asset.id}`);
  assert.equal(result.rows.length, 1);
  return result.rows[0] as Saved;
}
before(async () => {
  assert.ok(db.$client instanceof PGlite);
  await db.$client.exec(`CREATE TABLE "user"(id TEXT PRIMARY KEY);
    INSERT INTO "user" VALUES('creator'),('other');
    CREATE TABLE user_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL,filename TEXT NOT NULL,
      url TEXT NOT NULL,size_bytes INTEGER,mime_type TEXT,folder_id TEXT,source_asset_id TEXT,is_public BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE generated_image_sources(asset_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,metadata JSONB NOT NULL CHECK(metadata->>'prompt' != 'reject fixture'));
    CREATE TABLE image_generation_requests(user_id TEXT,request_id TEXT,state TEXT,asset_id TEXT,updated_at TIMESTAMP DEFAULT NOW());`);
  await db.$client.exec(IMAGE_MASTERS_DDL);
});

test('animated GIF and WebP retain every frame, delay, loop and complete file', { timeout: 30_000 }, async () => {
  const pixels = Buffer.from(Array.from({ length: 4 * 3 * 2 * 4 }, (_, i) => i % 4 === 3 ? 255 : i < 4 * 3 * 4 ? 20 : 220));
  for (const format of ['gif', 'webp'] as const) {
    const raster = sharp(pixels, { raw: { width: 4, height: 6, channels: 4, pageHeight: 3 } });
    const bytes = await (format === 'gif' ? raster.gif({ delay: [70, 130], loop: 3 })
      : raster.webp({ lossless: true, delay: [70, 130], loop: 3 })).toBuffer();
    const inputMetadata = await sharp(bytes, { animated: true }).metadata();
    assert.equal(inputMetadata.pages, 2);
    const asset = await generatedImageStorage.save('creator', bytes, source, signal());
    const saved = await readAsset(asset);
    assert.equal(saved.mime_type, `image/${format}`);
    assert.match(asset.filename, new RegExp(`\\.${format}$`));
    const recovered = (await getObjectBuffer(saved.url)).buffer;
    assert.deepEqual(recovered, bytes);
    const metadata = await sharp(recovered, { animated: true }).metadata();
    assert.deepEqual(metadata.delay, inputMetadata.delay);
    assert.equal(metadata.loop, inputMetadata.loop);
    assert.equal(metadata.pages, 2);
    assert.equal(saved.metadata.height, 3);
    if (format === 'gif') {
      const oversized = Buffer.from(bytes);
      oversized.writeUInt16LE(65535, 6); oversized.writeUInt16LE(65535, 8);
      await assert.rejects(validateGeneratedRaster(oversized, signal()), /valid supported raster/);
    }
  }
});

test('AVIF keeps its original container and metadata instead of becoming a PNG', { timeout: 30_000 }, async () => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345680' } })
    .avif({ lossless: true }).withMetadata().toBuffer();
  const asset = await generatedImageStorage.save('creator', bytes, source, signal());
  const saved = await readAsset(asset);
  assert.equal(saved.mime_type, 'image/avif');
  assert.match(asset.filename, /\.avif$/);
  assert.deepEqual((await getObjectBuffer(saved.url)).buffer, bytes);
});

test('different provider metadata produces distinct masters even when pixels match', { timeout: 30_000 }, async () => {
  const input = sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } });
  const first = await input.clone().png().withExifMerge({ IFD0: { ImageDescription: 'workflow one' } }).toBuffer();
  const second = await input.clone().png().withExifMerge({ IFD0: { ImageDescription: 'workflow two' } }).toBuffer();
  assert.deepEqual(await sharp(first).raw().toBuffer(), await sharp(second).raw().toBuffer());
  const a = await readAsset(await generatedImageStorage.save('creator', first, source, signal()));
  const b = await readAsset(await generatedImageStorage.save('creator', second, source, signal()));
  assert.notEqual(a.url, b.url);
  assert.deepEqual((await getObjectBuffer(a.url)).buffer, first);
  assert.deepEqual((await getObjectBuffer(b.url)).buffer, second);
});

test('a no-op explicit transform keeps distinct original/final references to one verified master', { timeout: 30_000 }, async () => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345600' } }).png().toBuffer();
  const asset = await generatedImageStorage.save('creator', bytes, { ...source, transparent: true }, signal(), { originalBytes: bytes });
  assert.ok(asset.source.originalAssetId);
  assert.notEqual(asset.id, asset.source.originalAssetId);
  const a = await readAsset(asset), b = await readAsset({ ...asset, id: asset.source.originalAssetId! });
  assert.equal(a.url, b.url);
  assert.deepEqual((await getObjectBuffer(a.url)).buffer, bytes);
});

test('registration rollback retains shared and newly orphaned immutable masters', { timeout: 30_000 }, async t => {
  const bytes = await sharp({ create: { width: 5, height: 3, channels: 3, background: '#314159' } }).png().toBuffer();
  const asset = await generatedImageStorage.save('creator', bytes, source, signal());
  const saved = await readAsset(asset);
  await assert.rejects(generatedImageStorage.save('creator', bytes, { ...source, prompt: 'reject fixture' }, signal()), /could not be saved/);
  assert.deepEqual((await getObjectBuffer(saved.url)).buffer, bytes);
  const orphan = await sharp({ create: { width: 6, height: 3, channels: 3, background: '#314159' } }).png().toBuffer();
  const storage = getLocalDiskStorage(), write = storage.putObject.bind(storage), writtenKeys: string[] = [];
  t.mock.method(storage, 'putObject', async (...args: Parameters<typeof write>) => { writtenKeys.push(args[0]); return write(...args); });
  await assert.rejects(generatedImageStorage.save('creator', orphan, { ...source, prompt: 'reject fixture' }, signal()), /could not be saved/);
  assert.equal(writtenKeys.length, 1);
  assert.equal(await imageMasters.find('creator', 'public', digest(orphan)), undefined, 'the logical transaction rolled back');
  assert.deepEqual((await getObjectBuffer(writtenKeys[0]!)).buffer, orphan, 'the uncertain orphan is retained without exposing a hash-derived URL');
});

test('provider validation rejects malformed pixel data, active content, oversized dimensions and cancellation', { timeout: 30_000 }, async () => {
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  await assert.rejects(validateGeneratedRaster(png.subarray(0, png.length - 25), signal()), /valid supported raster/);
  await assert.rejects(validateGeneratedRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), signal()), /valid supported raster/);
  const tooWide = Buffer.from(png);
  tooWide.writeUInt32BE(10000, 16); tooWide.writeUInt32BE(4001, 20);
  tooWide.writeUInt32BE(crc32(tooWide.subarray(12, 29)), 29);
  await assert.rejects(validateGeneratedRaster(tooWide, signal()), /valid supported raster/);
  const animationChunk = Buffer.alloc(20);
  animationChunk.writeUInt32BE(8); animationChunk.write('acTL', 4); animationChunk.writeUInt32BE(2, 8);
  animationChunk.writeUInt32BE(crc32(animationChunk.subarray(4, 16)), 16);
  const apng = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]);
  await assert.rejects(validateGeneratedRaster(apng, signal()), /Animated PNG.*fully validated/);
  const controller = new AbortController(); controller.abort(new Error('cancel fixture'));
  await assert.rejects(generatedImageStorage.save('creator', png, source, controller.signal), /cancel fixture/);
});
after(async () => {
  assert.ok(db.$client instanceof PGlite);
  await db.$client.close();
});

test('generated PNG master retains complete provider metadata and bytes', { timeout: 30_000 }, async () => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345680' } })
    .png().withMetadata().withExifMerge({ IFD0: { ImageDescription: 'provider workflow fixture'.repeat(100) } }).toBuffer();
  const asset = await generatedImageStorage.save('creator', bytes, source, signal());
  const saved = await readAsset(asset);
  assert.match(saved.url, /\/image-masters\/public\/[a-f0-9]{64}\.png$/);
  assert.equal((await imageMasters.find('creator', 'public', digest(bytes)))?.key, saved.url);
  assert.notEqual(saved.url.split('/').at(-1), `${digest(bytes)}.png`, 'public URLs do not expose the content address');
  assert.equal(saved.mime_type, 'image/png');
  assert.equal(saved.size_bytes, bytes.length);
  assert.match(asset.filename, /\.png$/);
  assert.deepEqual((await getObjectBuffer(saved.url)).buffer, bytes);
  const stored = await headObject(saved.url);
  assert.equal(stored.contentEncoding, 'gzip');
  assert.equal(stored.decodedLength, bytes.length);
  assert.ok(stored.contentLength < bytes.length);
  assert.equal(saved.metadata.width, 4);
  assert.equal(saved.metadata.height, 3);
});

test('identical provider output reuses the physical master without merging logical assets or owners', { timeout: 30_000 }, async () => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#314159' } }).jpeg().withMetadata().toBuffer();
  const first = await generatedImageStorage.save('creator', bytes, { ...source, prompt: 'first' }, signal());
  const second = await generatedImageStorage.save('creator', bytes, { ...source, prompt: 'second' }, signal());
  const foreign = await generatedImageStorage.save('other', bytes, source, signal());
  const [a, b, c] = await Promise.all([readAsset(first), readAsset(second), readAsset(foreign)]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.filename, second.filename);
  assert.equal(a.url, b.url);
  assert.notEqual(a.url, c.url);
  assert.equal(a.mime_type, 'image/jpeg');
  assert.match(first.filename, /\.jpg$/);
  assert.equal(a.metadata.prompt, 'first');
  assert.equal(b.metadata.prompt, 'second');
  assert.deepEqual((await getObjectBuffer(a.url)).buffer, bytes);
});

test('explicit sprite processing retains a raw original and distinct derivative IDs', { timeout: 30_000 }, async () => {
  const original = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#00ff00' } })
    .png().withMetadata().toBuffer();
  const final = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345600' } }).png().toBuffer();
  const asset = await generatedImageStorage.save('creator', final,
    { ...source, imageKind: 'sprite', transparent: true, greenRemoved: true,
      processingStatus: 'review_required', processingMs: 23, reviewRequired: true, reviewReasons: ['derivative fixture'],
      foregroundCoverage: 0.5, segmentationModel: 'fixture-mask' }, signal(), { originalBytes: original });
  const saved = await readAsset(asset);
  assert.ok(asset.source.originalAssetId);
  assert.notEqual(asset.id, asset.source.originalAssetId);
  const originalAsset = await readAsset({ ...asset, id: asset.source.originalAssetId! });
  assert.equal(originalAsset.metadata.assetRole, 'original');
  assert.equal(originalAsset.metadata.transparent, false);
  assert.equal(originalAsset.metadata.greenRemoved, false);
  assert.equal(originalAsset.metadata.processingStatus, undefined);
  assert.equal(originalAsset.metadata.processingMs, undefined);
  assert.equal(originalAsset.metadata.reviewRequired, undefined);
  assert.equal(originalAsset.metadata.reviewReasons, undefined);
  assert.equal(originalAsset.metadata.foregroundCoverage, undefined);
  assert.equal(originalAsset.metadata.segmentationModel, undefined);
  assert.equal(saved.metadata.reviewRequired, true);
  assert.deepEqual((await getObjectBuffer(originalAsset.url)).buffer, original);
  assert.notEqual(originalAsset.url, saved.url);
  assert.equal(saved.metadata.assetRole, 'final');
  assert.equal((await sharp((await getObjectBuffer(saved.url)).buffer).stats()).isOpaque, false);
  assert.equal((await headObject(originalAsset.url)).decodedLength ?? original.length, original.length);
});
