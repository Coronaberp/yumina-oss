import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { optimizeUploadedImage, isAnimatedPng, losslessWebpKey } from "./image-optimization.js";
import { LocalDiskStorage } from "./storage/local-disk.js";

async function fixture() {
  return sharp({ create: { width: 16, height: 12, channels: 4, background: "#12345680" } })
    .withExif({ IFD0: { ImageDescription: "Synthetic original prompt metadata" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">synthetic workflow</x:xmpmeta>')
    .png({ compressionLevel: 0 }).toBuffer();
}

function storageFixture(bytes: Buffer) {
  let reads = 0, writes = 0;
  return {
    read: async () => { reads++; return { buffer: bytes, contentType: "image/png" }; },
    write: async () => { writes++; },
    counts: () => ({ reads, writes }),
  };
}

test("the retired optimizer returns the same metadata object and never reads or rewrites an original", async () => {
  const bytes = await fixture(), before = Buffer.from(bytes), storage = storageFixture(bytes);
  const asset = Object.freeze({ key: "users/test/source.png", filename: "authored original.png", mimeType: "image/png", sizeBytes: bytes.length });
  const result = await optimizeUploadedImage(asset, storage);
  assert.equal(result, asset, "legacy callers retain their exact object, key, filename, MIME and size");
  assert.deepEqual(storage.counts(), { reads: 0, writes: 0 });
  assert.deepEqual(bytes, before, "complete source bytes retain embedded metadata and alpha");
});

test("legacy passthrough is format- and size-independent, including malformed and animated inputs", async () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/apng", "image/avif", "image/tiff", "audio/mpeg"]) {
    const storage = storageFixture(Buffer.from("opaque original bytes"));
    const asset = { key: "users/test/source", filename: "source", mimeType, sizeBytes: 100 * 1024 * 1024 };
    assert.equal(await optimizeUploadedImage(asset, storage), asset);
    assert.deepEqual(storage.counts(), { reads: 0, writes: 0 }, mimeType);
  }
});

test("legacy calls do not recover or publish alternate WebP objects after staging cleanup", async () => {
  const asset = { key: "users/test/missing.png", filename: "missing.png", mimeType: "image/png", sizeBytes: 123 };
  let reads = 0;
  const storage = { read: async () => { reads++; throw new Error("Missing staging original"); }, write: async () => assert.fail("No alternate image may be published") };
  assert.equal(await optimizeUploadedImage(asset, storage), asset);
  assert.deepEqual(await Promise.all([optimizeUploadedImage(asset, storage), optimizeUploadedImage(asset, storage)]), [asset, asset]);
  assert.equal(reads, 0);
});

test("existing legacy key and conservative PNG animation helpers remain compatible", async () => {
  assert.equal(losslessWebpKey("users/test/image.png"), "users/test/image.png.lossless.webp");
  assert.equal(losslessWebpKey("worlds/test/no-extension"), "worlds/test/no-extension.lossless.webp");
  const png = await fixture();
  assert.equal(isAnimatedPng(png), false);
  assert.equal(isAnimatedPng(Buffer.from("GIF89a")), false);
  assert.equal(isAnimatedPng(Buffer.from("JPEG")), false);
  const control = Buffer.alloc(20); control.writeUInt32BE(8, 0); control.write("acTL", 4); control.writeUInt32BE(2, 8);
  assert.equal(isAnimatedPng(Buffer.concat([png.subarray(0, 33), control, png.subarray(33)])), true);
  assert.equal(isAnimatedPng(png.subarray(0, 12)), true, "inconclusive PNG headers remain conservative");
  const malformed = Buffer.concat([png.subarray(0, 8), Buffer.from([255, 255, 255, 255]), Buffer.from("tEXt"), Buffer.alloc(4)]);
  assert.equal(isAnimatedPng(malformed), true);
});

test("legacy passthrough leaves an isolated local file and its published metadata byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-master-preservation-"));
  try {
    const storage = new LocalDiskStorage({ root, publicOrigin: "http://test.local", secret: "isolated-test-only" });
    const bytes = await fixture(), key = "worlds/test/image/source.png";
    await storage.putObject(key, bytes, "image/png");
    const beforeMeta = await readFile(storage.resolveMetaPath(key));
    let reads = 0, writes = 0;
    const asset = { key, filename: "source.png", mimeType: "image/png", sizeBytes: bytes.length };
    assert.equal(await optimizeUploadedImage(asset, {
      read: async (...args) => { reads++; return storage.getObjectBuffer(...args); },
      write: async (...args) => { writes++; return storage.putObject(...args); },
    }), asset);
    assert.equal(reads, 0); assert.equal(writes, 0);
    assert.deepEqual(await readFile(storage.resolvePath(key)), bytes);
    assert.deepEqual(await readFile(storage.resolveMetaPath(key)), beforeMeta);
    assert.equal((await storage.headObject(key)).contentType, "image/png");
  } finally { await rm(root, { recursive: true, force: true }); }
});
