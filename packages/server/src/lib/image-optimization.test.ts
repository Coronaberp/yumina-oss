import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { optimizeUploadedImage } from "./image-optimization.js";
import { LocalDiskStorage } from "./storage/local-disk.js";

async function fixture(width = 3001, height = 32) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i / 4) % 256;
    pixels[i + 1] = 137;
    pixels[i + 2] = 211;
    pixels[i + 3] = (i / 4) % 3 === 0 ? 0 : (i / 4) % 3 === 1 ? 128 : 255;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
}

function memoryStorage(bytes: Buffer, contentType = "image/png") {
  const objects = new Map([["users/test/image/source.png", { buffer: bytes, contentType }]]);
  let reads = 0;
  return {
    objects,
    get reads() { return reads; },
    read: async (key: string, options?: { maxBytes?: number }) => {
      reads++;
      assert.ok(options?.maxBytes, "decoding must have a bounded input size");
      const object = objects.get(key);
      if (!object) throw new Error("Object not found");
      return object;
    },
    write: async (key: string, buffer: Buffer, mime: string) => { objects.set(key, { buffer, contentType: mime }); },
  };
}

test("uploads become smaller lossless WebP with identical dimensions and every RGBA pixel", async () => {
  const input = await fixture();
  const storage = memoryStorage(input);
  const result = await optimizeUploadedImage({ key: "users/test/image/source.png", filename: "source.png", mimeType: "image/png", sizeBytes: input.length }, storage);
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.filename, "source.webp");
  assert.match(result.key, /\.webp$/);
  const output = storage.objects.get(result.key)!;
  assert.equal(output.contentType, "image/webp");
  assert.equal(result.sizeBytes, output.buffer.length);
  assert.ok(result.sizeBytes < input.length);
  const decoded = await sharp(output.buffer).metadata();
  assert.equal(decoded.width, 3001, "large uploads retain their full resolution");
  assert.equal(decoded.height, 32);
  assert.equal(decoded.hasAlpha, true);
  assert.deepEqual(await sharp(output.buffer).ensureAlpha().raw().toBuffer(), await sharp(input).ensureAlpha().raw().toBuffer(), "including RGB underneath fully transparent pixels");
  assert.deepEqual(storage.objects.get("users/test/image/source.png")!.buffer, input, "source remains available until registration commits");
});

test("small PNG uploads also use lossless compression", async () => {
  const input = await fixture(100, 100);
  assert.ok(input.length < 512 * 1024);
  const result = await optimizeUploadedImage({ key: "users/test/image/source.png", filename: "source.png", mimeType: "image/png", sizeBytes: input.length }, memoryStorage(input));
  assert.equal(result.mimeType, "image/webp");
});

test("conversion keeps originals when WebP is larger or input is unsupported", async () => {
  const pixels = Buffer.alloc(80 * 80 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 179 + (i >> 3) * 83) % 256;
  const jpeg = await sharp(pixels, { raw: { width: 80, height: 80, channels: 3 } }).jpeg({ quality: 40 }).toBuffer();
  assert.ok((await sharp(jpeg).webp({ lossless: true, exact: true, effort: 6 }).toBuffer()).length > jpeg.length);
  for (const [input, mimeType] of [[jpeg, "image/jpeg"], [Buffer.from("invalid"), "image/png"], [Buffer.from("audio"), "audio/mpeg"], [Buffer.from("GIF89a"), "image/gif"]] as const) {
    const storage = memoryStorage(input, mimeType);
    const asset = { key: "users/test/image/source.png", filename: "source.png", mimeType, sizeBytes: input.length };
    const result = await optimizeUploadedImage(asset, storage);
    assert.deepEqual(result, asset);
    assert.equal(storage.objects.size, 1);
  }
});

test("APNG and animated WebP uploads retain their frames and original bytes", async () => {
  const png = await fixture(8, 8);
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0); control.write("acTL", 4); control.writeUInt32BE(2, 8);
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  const frames = Buffer.alloc(8 * 16 * 4, 120);
  frames.fill(220, 8 * 8 * 4);
  const animation = await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ lossless: true, delay: [100, 200], loop: 0 }).toBuffer();
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
  for (const [input, mimeType] of [[apng, "image/png"], [animation, "image/webp"]] as const) {
    const storage = memoryStorage(input, mimeType);
    const asset = { key: "users/test/image/source.png", filename: "source.png", mimeType, sizeBytes: input.length };
    assert.deepEqual(await optimizeUploadedImage(asset, storage), asset);
    assert.equal(storage.objects.size, 1);
  }
});

test("storage failure leaves the original upload usable", async () => {
  const input = await fixture(20, 20);
  const asset = { key: "users/test/image/source.png", filename: "source.png", mimeType: "image/png", sizeBytes: input.length };
  const storage = memoryStorage(input);
  assert.deepEqual(await optimizeUploadedImage(asset, { ...storage, write: async () => { throw new Error("Storage unavailable"); } }), asset);
  assert.equal(storage.objects.size, 1);
});

test("confirmation retries reuse a converted image after staging cleanup", async () => {
  const input = await fixture(100, 100);
  const asset = { key: "users/test/image/source.png", filename: "source.png", mimeType: "image/png", sizeBytes: input.length };
  const storage = memoryStorage(input);
  const result = await optimizeUploadedImage(asset, storage);
  storage.objects.delete(asset.key);
  assert.deepEqual(await optimizeUploadedImage(asset, storage), result);
});

test("local disk serves converted bytes with WebP MIME and the actual byte count", async () => {
  const root = await mkdtemp(join(tmpdir(), "yumina-lossless-upload-"));
  try {
    const storage = new LocalDiskStorage({ root, publicOrigin: "http://test.local", secret: "isolated-test-only" });
    const input = await fixture(100, 100);
    const key = "worlds/test/image/source.png";
    await storage.putObject(key, input, "image/png");
    const asset = await optimizeUploadedImage({ key, filename: "source.png", mimeType: "image/png", sizeBytes: input.length }, {
      read: storage.getObjectBuffer.bind(storage), write: storage.putObject.bind(storage),
    });
    const stored = await storage.headObject(asset.key);
    assert.equal(stored.contentType, "image/webp");
    assert.equal(stored.contentLength, asset.sizeBytes);
    assert.equal((await sharp((await storage.getObjectBuffer(asset.key)).buffer).metadata()).format, "webp");
  } finally { await rm(root, { recursive: true, force: true }); }
});
