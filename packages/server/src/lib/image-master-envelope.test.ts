import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync, deflateSync } from "node:zlib";
import test from "node:test";
import sharp from "sharp";
import { transform } from "sucrase";
import type { encodeImageMaster as EncodeImageMaster } from "./image-master-envelope.js";

function noise(length: number, initial = 0x51a7c3) {
  const bytes = Buffer.alloc(length); let seed = initial;
  for (let index = 0; index < length; index++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[index] = seed & 255; }
  return bytes;
}
function tracedEncoder() {
  const require = createRequire(import.meta.url), zlib = require("node:zlib") as typeof import("node:zlib");
  const compressors: import("node:zlib").Gzip[] = [];
  const module = { exports: {} as { encodeImageMaster: typeof EncodeImageMaster } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./image-master-envelope.ts", import.meta.url), "utf8"), { transforms: ["typescript", "imports"] }).code)(
    (name: string) => name === "node:zlib" ? { ...zlib, createGzip: (options: import("node:zlib").ZlibOptions) => { const stream = zlib.createGzip(options); compressors.push(stream); return stream; } } : require(name), module, module.exports,
  );
  return { encode: module.exports.encodeImageMaster, passes: () => compressors.map(stream => stream.bytesWritten) };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}
function apngFixture() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0); animation.writeUInt32BE(3, 4);
  const frame = (sequence: number, delay: number) => { const data = Buffer.alloc(26); data.writeUInt32BE(sequence, 0); data.writeUInt32BE(2, 4); data.writeUInt32BE(1, 8); data.writeUInt16BE(delay, 20); data.writeUInt16BE(10, 22); return chunk("fcTL", data); };
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("acTL", animation),
    chunk("tEXt", Buffer.from("parameters\0" + "synthetic prompt metadata ".repeat(20))), frame(0, 1),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]))), frame(1, 2),
    chunk("fdAT", Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 0, 255, 255, 180, 100, 10, 0]))])), chunk("IEND", Buffer.alloc(0))]);
}
async function subject() {
  assert.ok(existsSync(new URL("./image-master-envelope.ts", import.meta.url)), "the byte-preserving image envelope must exist");
  return import("./image-master-envelope.js");
}

test("image envelopes recover complete original static and animated files including metadata", async () => {
  const { encodeImageMaster } = await subject();
  const pixels = Buffer.alloc(8 * 16 * 4, 100); pixels.fill(220, 8 * 8 * 4);
  const image = () => sharp({ create: { width: 16, height: 12, channels: 4, background: "#12345680" } });
  const fixtures = [
    await image().withExif({ IFD0: { ImageDescription: "Synthetic prompt; preserve this metadata" } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">synthetic workflow</x:xmpmeta>').png({ compressionLevel: 0 }).toBuffer(),
    await image().toColourspace("rgb16").png().toBuffer(),
    await image().jpeg().toBuffer(),
    await image().webp({ lossless: true }).toBuffer(),
    await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ delay: [100, 200], loop: 3 }).toBuffer(),
    await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ lossless: true, delay: [120, 230], loop: 2 }).toBuffer(),
    apngFixture(),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><metadata>synthetic prompt</metadata>' + '<rect width="8" height="8"/>'.repeat(30) + '</svg>'),
  ];
  let compressed = 0;
  for (const input of fixtures) {
    const before = Buffer.from(input), result = await encodeImageMaster(input);
    const recovered = result.contentEncoding === "gzip" ? gunzipSync(result.bytes) : result.bytes;
    assert.deepEqual(recovered, before);
    assert.deepEqual(input, before, "encoding never mutates original file bytes");
    assert.equal(result.sourceSha256, sha(before)); assert.equal(result.storedSha256, sha(result.bytes));
    assert.equal(result.originalSize, before.length); assert.equal(result.storedSize, result.bytes.length);
    assert.ok(result.storedSize <= result.originalSize);
    if (result.contentEncoding) { compressed++; assert.ok(result.storedSize < result.originalSize); }
  }
  assert.ok(compressed > 0);
});

test("unprofitable, oversized and contended optimization returns the exact raw buffer", async () => {
  const { encodeImageMaster, IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES } = await subject();
  for (const input of [Buffer.alloc(0), randomBytes(32), Buffer.alloc(IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES + 1)]) {
    const result = await encodeImageMaster(input);
    assert.equal(result.bytes, input); assert.equal(result.contentEncoding, undefined);
    assert.equal(result.sourceSha256, result.storedSha256);
  }
  const input = Buffer.alloc(1024 * 1024, 123);
  const first = encodeImageMaster(input), second = encodeImageMaster(input);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.contentEncoding, "gzip"); assert.equal(b.bytes, input); assert.equal(b.contentEncoding, undefined);
});

test("small negligible savings retain original bytes and use only one compression pass", async () => {
  const input = Buffer.concat([noise(8192), Buffer.alloc(80)]);
  const gzip = gzipSync(input, { level: 1 });
  assert.ok(gzip.length < input.length && gzip.length * 100 > input.length * 99, "fixture saves less than one percent");
  const traced = tracedEncoder(), result = await traced.encode(input);
  assert.ok(result.bytes === input, "negligible savings retain the original buffer"); assert.equal(result.contentEncoding, undefined);
  assert.equal(result.sourceSha256, sha(input)); assert.equal(result.storedSha256, sha(input));
  assert.deepEqual(traced.passes(), [input.length]);
});

test("an incompressible 64KiB prefix skips full recompression even when later bytes are compressible", async () => {
  const prefix = noise(64 * 1024), input = Buffer.concat([prefix, Buffer.alloc(3 * 64 * 1024)]);
  assert.ok(gzipSync(prefix, { level: 1 }).length * 100 > prefix.length * 99);
  const traced = tracedEncoder(), result = await traced.encode(input);
  assert.ok(result.bytes === input, "an unprofitable prefix retains the original buffer"); assert.equal(result.contentEncoding, undefined);
  assert.equal(result.sourceSha256, sha(input)); assert.equal(result.storedSha256, sha(input));
  assert.deepEqual(traced.passes(), [prefix.length], "only the bounded prefix enters the codec");
});

test("a profitable prefix still requires at least one percent full-file savings", async () => {
  const prefix = Buffer.concat([noise(63 * 1024), Buffer.alloc(1024)]), input = Buffer.concat([prefix, noise(3 * 64 * 1024, 0x1738)]);
  assert.ok(gzipSync(prefix, { level: 1 }).length * 100 <= prefix.length * 99);
  const gzip = gzipSync(input, { level: 1 });
  assert.ok(gzip.length < input.length && gzip.length * 100 > input.length * 99);
  const traced = tracedEncoder(), result = await traced.encode(input);
  assert.ok(result.bytes === input, "negligible full-file savings retain the original buffer"); assert.equal(result.contentEncoding, undefined);
  assert.deepEqual(traced.passes(), [prefix.length, input.length]);
});

test("a profitable sampled file retains exact bytes, hashes and two bounded codec passes", async () => {
  const input = Buffer.from("original metadata and animation bytes\n".repeat(6000));
  const traced = tracedEncoder(), result = await traced.encode(input);
  assert.equal(result.contentEncoding, "gzip"); assert.ok(result.bytes.length * 100 <= input.length * 99);
  assert.deepEqual(gunzipSync(result.bytes), input); assert.equal(result.sourceSha256, sha(input));
  assert.equal(result.storedSha256, sha(result.bytes)); assert.deepEqual(traced.passes(), [64 * 1024, input.length]);
});

test("cancellation rejects before and during compression and releases its single slot", async () => {
  const { encodeImageMaster } = await subject();
  const aborted = AbortSignal.abort();
  await assert.rejects(encodeImageMaster(Buffer.alloc(1024), { signal: aborted }), { name: "AbortError" });
  const controller = new AbortController();
  const pending = encodeImageMaster(Buffer.alloc(1024 * 1024), { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await encodeImageMaster(Buffer.alloc(1024))).contentEncoding, "gzip");
});

test("only marked image envelopes decode, with bounded length and both hashes verified", async () => {
  const { decodeImageMaster } = await subject();
  const input = Buffer.from("complete original image bytes ".repeat(100)); const bytes = gzipSync(input);
  const metadata = { contentType: "image/png", contentEncoding: "gzip", decodedLength: input.length, sourceSha256: sha(input), storedSha256: sha(bytes) };
  assert.deepEqual(await decodeImageMaster(bytes, metadata), input);
  for (const change of [{ contentType: "application/gzip" }, { sourceSha256: undefined }, { contentEncoding: undefined }]) {
    assert.equal(await decodeImageMaster(bytes, { ...metadata, ...change }), bytes, "legacy gzip semantics remain unchanged");
  }
  for (const change of [{ decodedLength: input.length - 1 }, { sourceSha256: "0".repeat(64) }, { storedSha256: "0".repeat(64) }, { decodedLength: undefined }, { storedSha256: undefined }]) {
    await assert.rejects(decodeImageMaster(bytes, { ...metadata, ...change }), /image master/i);
  }
  await assert.rejects(decodeImageMaster(bytes, metadata, { maxBytes: input.length - 1 }), /limit/i);
  await assert.rejects(decodeImageMaster(bytes.subarray(0, -3), { ...metadata, storedSha256: sha(bytes.subarray(0, -3)) }), /image master/i);
  await assert.rejects(decodeImageMaster(bytes, metadata, { signal: AbortSignal.abort() }), { name: "AbortError" });
});
