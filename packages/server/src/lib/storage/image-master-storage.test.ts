import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import sharp from "sharp";
import { LocalDiskStorage } from "./local-disk.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function streamBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
test("local image envelopes preserve metadata across restart, copy and dedup with decoded buffer reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-envelope-"));
  try {
    const options = { root, publicOrigin: "http://localhost", secret: "isolated-test-only" };
    const storage = new LocalDiskStorage(options);
    const original = Buffer.from("original PNG metadata and animation ".repeat(200)), bytes = gzipSync(original);
    const meta = { contentEncoding: "gzip", decodedLength: original.length, sourceSha256: sha(original), storedSha256: sha(bytes) };
    await storage.putObject("users/test/master.png", bytes, "image/png", meta);
    const reopened = new LocalDiskStorage(options);
    const head = await reopened.headObject("users/test/master.png");
    for (const [key, value] of Object.entries(meta)) assert.equal(head[key as keyof typeof head], value);
    assert.equal(head.contentLength, bytes.length);
    const object = await reopened.getObject("users/test/master.png");
    const wire = await streamBytes(object.body); assert.deepEqual(wire, bytes);
    assert.deepEqual((await reopened.getObjectBuffer("users/test/master.png")).buffer, original);
    await assert.rejects(reopened.getObjectBuffer("users/test/master.png", { maxBytes: original.length - 1 }), /limit|large/i);
    await reopened.copyObject("users/test/master.png", "users/test/copy.png");
    await reopened.deduplicateObject("users/test/copy.png");
    assert.deepEqual((await reopened.getObjectBuffer("users/test/copy.png")).buffer, original);
    const copyHead = await reopened.headObject("users/test/copy.png");
    for (const [key, value] of Object.entries(meta)) assert.equal(copyHead[key as keyof typeof copyHead], value);
    const sidecar = JSON.parse(await readFile(reopened.resolveMetaPath("users/test/copy.png"), "utf8"));
    assert.equal(sidecar.sha256, sha(bytes), "local hardlink index hashes stored bytes, separately from source SHA");
    assert.deepEqual(await streamBytes((await reopened.getObject("users/test/copy.png")).body), bytes);
    await reopened.putObject("worlds/pvz-previews/pack.gz", bytes, "application/gzip", { contentEncoding: "gzip", decodedLength: original.length });
    assert.deepEqual((await reopened.getObjectBuffer("worlds/pvz-previews/pack.gz")).buffer, bytes);
    await reopened.putObject("users/test/bad.png", Buffer.from("broken gzip"), "image/png", { ...meta, storedSha256: sha(Buffer.from("broken gzip")) });
    await assert.rejects(reopened.getObjectBuffer("users/test/bad.png"), /image master/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local copies can correct destination MIME without rewriting source bytes or envelope metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "copy-mime-"));
  try {
    const storage = new LocalDiskStorage({ root, publicOrigin: "http://localhost", secret: "isolated-test-only" });
    const source = "users/test/source.jpg", destination = "users/test/master.png";
    const original = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#12345680" } })
      .withExif({ IFD0: { ImageDescription: "Synthetic original PNG metadata" } }).png({ compressionLevel: 0 }).toBuffer();
    const bytes = gzipSync(original);
    const metadata = { contentEncoding: "gzip", decodedLength: original.length, sourceSha256: sha(original), storedSha256: sha(bytes) };
    await storage.putObject(source, bytes, "image/jpeg", metadata);
    const beforeMeta = await readFile(storage.resolveMetaPath(source));
    await storage.copyObject(source, destination, { contentType: "image/png" });
    assert.equal((await storage.headObject(source)).contentType, "image/jpeg");
    assert.deepEqual(await readFile(storage.resolveMetaPath(source)), beforeMeta);
    const head = await storage.headObject(destination); assert.equal(head.contentType, "image/png");
    for (const [key, value] of Object.entries(metadata)) assert.equal(head[key as keyof typeof head], value);
    assert.deepEqual(await readFile(storage.resolvePath(destination)), bytes);
    assert.deepEqual((await storage.getObjectBuffer(destination)).buffer, original);
    assert.equal((await stat(storage.resolvePath(source))).ino, (await stat(storage.resolvePath(destination))).ino, "copy retains shared exact physical bytes");
    await storage.copyObject(source, "users/test/default.jpg");
    assert.equal((await storage.headObject("users/test/default.jpg")).contentType, "image/jpeg", "default copy semantics remain unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});
