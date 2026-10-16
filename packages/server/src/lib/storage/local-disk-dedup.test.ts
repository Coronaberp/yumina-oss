import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { LocalDiskStorage } from "./local-disk.js";

const image = Buffer.from("identical encoded image bytes");
const a = "users/alice/image/a.webp";
const b = "users/bob/image/b.webp";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yumina-dedup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const makeStorage = () => new LocalDiskStorage({ root, publicOrigin: "", secret: "dedup-tests-only" });
  const storage = makeStorage();
  const inode = async (key: string) => {
    const stat = await fs.stat(storage.resolvePath(key));
    return `${stat.dev}:${stat.ino}`;
  };
  const bytes = async (key: string) => (await storage.getObjectBuffer(key)).buffer;
  return { root, storage, makeStorage, inode, bytes };
}

test("identical uploads across accounts share bytes but retain independent MIME metadata", async t => {
  const { storage, inode, bytes } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  await storage.putObject(b, image, "application/octet-stream");
  assert.equal(await inode(a), await inode(b));
  assert.deepEqual(await bytes(a), image);
  assert.deepEqual(await bytes(b), image);
  assert.equal((await storage.headObject(a)).contentType, "image/webp");
  assert.equal((await storage.headObject(b)).contentType, "application/octet-stream");
});

test("streamed and buffered uploads and copies share a persistent index across storage instances", async t => {
  const { storage, makeStorage, inode } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  const restarted = makeStorage();
  await restarted.writeFromStream(b, "image/webp", Readable.from([image.subarray(0, 4), image.subarray(4)]));
  await restarted.copyObject(b, "worlds/card/image/copied.webp");
  assert.equal(await inode(a), await inode(b));
  assert.equal(await inode(a), await inode("worlds/card/image/copied.webp"));
});

test("concurrent equal writes from separate instances converge on one physical file", async t => {
  const { storage, makeStorage, inode } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => makeStorage().putObject(`users/${i}/same.webp`, image, "image/webp")));
  const identities = await Promise.all(Array.from({ length: 12 }, (_, i) => inode(`users/${i}/same.webp`)));
  assert.equal(new Set(identities).size, 1);
  assert.deepEqual((await storage.getObjectBuffer("users/7/same.webp")).buffer, image);
});

test("overwriting one shared object leaves other accounts and copied objects unchanged", async t => {
  const { storage, inode, bytes } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  await storage.copyObject(a, b);
  const replacement = Buffer.from("replacement only for alice");
  await storage.writeFromStream(a, "image/png", Readable.from([replacement]));
  assert.notEqual(await inode(a), await inode(b));
  assert.deepEqual(await bytes(a), replacement);
  assert.deepEqual(await bytes(b), image);
  assert.equal((await storage.headObject(b)).contentType, "image/webp");
  await storage.deleteObject(a);
  assert.deepEqual(await bytes(b), image);
});

test("prefix deletion preserves other accounts and frees the last blob reference", async t => {
  const { storage, inode, bytes } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  await storage.putObject(b, image, "image/webp");
  const original = await inode(a);
  assert.equal(await storage.deletePrefix("users/alice/"), 1);
  assert.deepEqual(await bytes(b), image);
  assert.equal(await inode(b), original);
  const survivor = await fs.stat(storage.resolvePath(b));
  assert.equal(survivor.nlink, 2, "one object plus its index link remains");
  await storage.deleteObject(b);
  await storage.putObject(a, image, "image/webp");
  const final = await fs.stat(storage.resolvePath(a));
  assert.equal(final.nlink, 2, "no deleted object remains linked");
  await storage.deleteObject(a);
  const blobs = path.join(storage.root, ".blobs", "sha256");
  const files = await fs.readdir(blobs, { recursive: true }).catch(() => []);
  assert.equal(files.filter(file => /^[a-f0-9]{64}$/.test(path.basename(file))).length, 0);
});

test("an oversized stream preserves the previous shared object without indexing partial bytes", async t => {
  const { storage, inode, bytes } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  await storage.putObject(b, image, "image/webp");
  await assert.rejects(() => storage.writeFromStream(a, "image/png", Readable.from([Buffer.from("too big")]), 3), { name: "EntityTooLarge" });
  assert.deepEqual(await bytes(a), image);
  assert.equal(await inode(a), await inode(b));
});

test("legacy consolidation preserves bytes, ETags, MIME and timestamps and is idempotent", async t => {
  const { storage, inode, bytes } = await fixture(t);
  for (const key of [a, b]) {
    await fs.mkdir(path.dirname(storage.resolvePath(key)), { recursive: true });
    await fs.writeFile(storage.resolvePath(key), image);
    await fs.mkdir(path.dirname(storage.resolveMetaPath(key)), { recursive: true });
    await fs.writeFile(storage.resolveMetaPath(key), JSON.stringify({ contentType: "image/webp", size: image.length, etag: key === a ? "legacy-a" : "legacy-b", createdAt: "2020-01-01T00:00:00.000Z" }));
  }
  // Maintenance is a production operation used by the instance backfill script.
  await storage.deduplicateObject(a);
  await storage.deduplicateObject(b);
  assert.equal(await inode(a), await inode(b));
  const before = await inode(a);
  await storage.deduplicateObject(b);
  assert.equal(await inode(b), before);
  assert.deepEqual(await bytes(b), image);
  assert.equal((await storage.headObject(a)).etag, "legacy-a");
  assert.equal((await storage.headObject(b)).etag, "legacy-b");
  const meta = JSON.parse(await fs.readFile(storage.resolveMetaPath(b), "utf8"));
  assert.equal(meta.createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(meta.contentType, "image/webp");
  assert.equal(meta.sha256, createHash("sha256").update(image).digest("hex"));
});

test("copying a legacy object and deleting both names leaves no retained blob", async t => {
  const { storage } = await fixture(t);
  await fs.mkdir(path.dirname(storage.resolvePath(a)), { recursive: true });
  await fs.writeFile(storage.resolvePath(a), image);
  await storage.copyObject(a, b);
  await storage.deleteObject(b);
  await storage.deleteObject(a);
  const blobs = path.join(storage.root, ".blobs", "sha256");
  const files = await fs.readdir(blobs, { recursive: true });
  assert.equal(files.filter(file => /^[a-f0-9]{64}$/.test(path.basename(file))).length, 0);
});

test("sharing with an existing upload never makes private legacy bytes readable by other OS users", async t => {
  const { storage, inode, bytes } = await fixture(t);
  await storage.putObject(a, image, "image/webp");
  await fs.mkdir(path.dirname(storage.resolvePath(b)), { recursive: true });
  await fs.writeFile(storage.resolvePath(b), image, { mode: 0o600 });
  await storage.deduplicateObject(b);
  assert.equal(await inode(a), await inode(b));
  const stat = await fs.stat(storage.resolvePath(b));
  assert.equal(stat.mode & 0o077, 0, "sharing must not widen filesystem access");
  assert.deepEqual(await bytes(a), image);
});

test("concurrent replacements leave the final object's MIME and ETag consistent with its bytes", async t => {
  const { storage, makeStorage, bytes } = await fixture(t);
  const versions = [
    { bytes: Buffer.from("first"), mime: "image/webp" },
    { bytes: Buffer.from("second version"), mime: "image/png" },
    { bytes: Buffer.from("third version is longer"), mime: "image/jpeg" },
  ];
  await Promise.all(versions.map(version => makeStorage().putObject(a, version.bytes, version.mime)));
  const actual = await bytes(a);
  const final = versions.find(version => version.bytes.equals(actual));
  assert.ok(final);
  const head = await storage.headObject(a);
  assert.equal(head.contentLength, final.bytes.length);
  assert.equal(head.contentType, final.mime);
  assert.equal(head.etag, createHash("md5").update(final.bytes).digest("hex"));
  await storage.deleteObject(a);
  const files = await fs.readdir(path.join(storage.root, ".blobs", "sha256"), { recursive: true });
  assert.equal(files.filter(file => /^[a-f0-9]{64}$/.test(path.basename(file))).length, 0);
});
