import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { storageRoutes } from "./storage.js";
import { generateUploadUrl, getLocalDiskStorage } from "../lib/s3.js";

const storage = getLocalDiskStorage();

test("signed upload length and expiry survive the local storage facade", async () => {
  const before = Date.now();
  const url = await generateUploadUrl("worlds/length/token.txt", "text/plain", { contentLength: 3, expiresIn: 5 });
  const token = new URL(url, "http://localhost").searchParams.get("token")!;
  const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
  assert.equal(claims.contentLength, 3);
  assert.ok(claims.exp >= before + 5000 && claims.exp <= Date.now() + 5000);
  assert.deepEqual(storage.verifyUploadToken(token), { key: "worlds/length/token.txt", contentType: "text/plain", contentLength: 3 });
});

async function upload(url: string, bytes: string, declared?: string) {
  return storageRoutes.request(new URL(url, "http://localhost").pathname.replace(/^\/storage/, "") + new URL(url, "http://localhost").search, {
    method: "PUT", headers: { "content-type": "text/plain", ...(declared === undefined ? {} : { "content-length": declared }) }, body: bytes,
  });
}

test("signed uploads count actual bytes with absent or lying headers and never replace prior bytes on mismatch", async () => {
  const key = "worlds/length/unchanged.txt";
  const shared = "users/length/shared.txt";
  await storage.putObject(key, Buffer.from("prior bytes"), "text/plain");
  await storage.copyObject(key, shared);
  const priorMeta = await storage.headObject(key);
  const priorStat = await fs.stat(storage.resolvePath(key));
  const url = await generateUploadUrl(key, "text/plain", { contentLength: 3, expiresIn: 600 });
  for (const [body, declared, status] of [["1234", undefined, 413], ["1234", "3", 413], ["12", undefined, 400], ["12", "3", 400]] as const) {
    const response = await upload(url, body, declared);
    assert.equal(response.status, status, await response.text());
    assert.equal((await storage.getObjectBuffer(key)).buffer.toString(), "prior bytes");
    assert.deepEqual(await storage.headObject(key), priorMeta);
    assert.equal((await fs.stat(storage.resolvePath(key))).ino, priorStat.ino);
    assert.equal((await storage.getObjectBuffer(shared)).buffer.toString(), "prior bytes");
  }
  for (const declared of [undefined, "3"]) {
    const response = await upload(url, "123", declared);
    assert.equal(response.status, 200, await response.text());
    assert.equal((await storage.headObject(key)).contentLength, 3);
    assert.equal((await storage.getObjectBuffer(key)).buffer.toString(), "123");
  }
  assert.equal((await storage.getObjectBuffer(shared)).buffer.toString(), "prior bytes");
  assert.equal((await fs.readdir(storage.resolvePath("worlds/length"))).some(name => name.includes(".tmp")), false);
});

test("old no-length upload URLs retain their streaming ceiling and deduplication", async () => {
  const key = "worlds/length/legacy.txt";
  const url = await generateUploadUrl(key, "text/plain");
  const response = await upload(url, "legacy bytes");
  assert.equal(response.status, 200, await response.text());
  await storage.putObject("users/length/equal.txt", Buffer.from("legacy bytes"), "text/plain");
  assert.equal((await fs.stat(storage.resolvePath(key))).ino, (await fs.stat(storage.resolvePath("users/length/equal.txt"))).ino);
});

test("signed lengths never bypass the local global ceiling, and zero-byte uploads succeed", async () => {
  const key = "worlds/length/ceiling.txt";
  const originalLimit = storage.maxUploadBytes;
  // Construct a valid claim above the configured ceiling without allocating a large body.
  const url = await generateUploadUrl(key, "text/plain", { contentLength: originalLimit + 1, expiresIn: 600 });
  assert.equal((await upload(url, "123", String(originalLimit + 1))).status, 413);
  await assert.rejects(storage.headObject(key));
  const empty = await generateUploadUrl(key, "text/plain", { contentLength: 0, expiresIn: 600 });
  assert.equal((await upload(empty, "")).status, 200);
  assert.equal((await storage.headObject(key)).contentLength, 0);
  assert.equal((await upload(empty, "1")).status, 413);
  assert.equal((await storage.headObject(key)).contentLength, 0);
});
