import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { createImageMasterService } from "./image-master-service.js";

const client = new PGlite();
const objects = new Map<string, Buffer>();
const mimes = new Map<string, string>();
let writes = 0;
const digest = (input: Buffer) => createHash("sha256").update(input).digest("hex");
const service = createImageMasterService(drizzle(client) as unknown as DrizzleDB, {
  encode: async (bytes: Buffer) => ({ bytes, sourceSha256: digest(bytes), storedSha256: digest(bytes), originalSize: bytes.length, storedSize: bytes.length }),
  write: async (key: string, bytes: Buffer, mimeType: string) => { writes++; objects.set(key, Buffer.from(bytes)); mimes.set(key,mimeType); },
});
before(async () => {
  await client.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');`);
  await client.exec(IMAGE_MASTERS_DDL);
});
after(async () => { await client.close(); });

test("exact original bytes are reused only for the same owner and access class", async () => {
  const bytes = Buffer.from("complete original image including profile and animation metadata");
  const first = await service.store({ userId: "alice", access: "public", bytes, mimeType: "image/png", sourceSha256: digest(bytes) });
  const replay = await service.store({ userId: "alice", access: "public", bytes, mimeType: "image/png" });
  assert.equal(replay.key, first.key); assert.equal(writes, 1);
  assert.deepEqual(objects.get(first.key), bytes); assert.equal(first.sourceSha256, digest(bytes));
  assert.equal(first.originalSize, bytes.length); assert.equal(first.mimeType, "image/png");
  const locator=first.key.split("/").at(-1)!.split(".")[0]!;
  assert.match(locator,/^[a-f0-9]{64}$/);assert.notEqual(locator,first.sourceSha256,"public locator must not reveal the source hash");
  assert.deepEqual(await service.find("alice", "public", digest(bytes)), first);
  assert.equal(await service.find("bob", "public", digest(bytes)), undefined);
  assert.equal(await service.find("alice", "private", digest(bytes)), undefined);
  assert.equal(await service.findByKey("bob", "public", first.key), undefined);
  const otherOwner = await service.store({ userId: "bob", access: "public", bytes, mimeType: "image/png" });
  const privateCopy = await service.store({ userId: "alice", access: "private", bytes, mimeType: "image/png" });
  assert.notEqual(otherOwner.key, first.key); assert.notEqual(privateCopy.key, first.key);
  assert.notEqual(first.key.replace("/alice/","/bob/"),otherOwner.key,"another owner's URL must not be derived from a known owner's locator");
  assert.equal(await service.findByKey("bob","public",`users/bob/image-masters/public/${digest(bytes)}.bin`),undefined,"known file hash must not become a public existence oracle");
  assert.equal(objects.has(`users/bob/image-masters/public/${digest(bytes)}.bin`),false);
  assert.match(privateCopy.key, /^private-session-media\/alice\//);
});

test("spoofed input digest cannot create or reuse a master", async () => {
  const before = writes;
  await assert.rejects(service.store({ userId: "alice", access: "public", bytes: Buffer.from("changed image bytes"), mimeType: "image/png", sourceSha256: "a".repeat(64) }), /hash|digest/i);
  assert.equal(writes, before);
  assert.equal(await service.find("alice", "public", "a".repeat(64)), undefined);
});

test("concurrent creation and lost-response replay converge without overwriting a canonical master", async () => {
  const bytes = Buffer.from("new concurrent image"); const before = writes;
  const results = await Promise.all(Array.from({length: 3}, () => service.store({ userId: "alice", access: "public", bytes, mimeType: "image/webp" })));
  assert.equal(new Set(results.map(result => result.key)).size, 1); assert.equal(writes, before + 1);
  assert.ok(!results[0]!.key.includes(digest(bytes)),"concurrent creation retains one opaque locator rather than exposing its content digest");
  assert.equal((await service.store({ userId: "alice", access: "public", bytes, mimeType: "image/webp" })).key, results[0]!.key);
  assert.equal(writes, before + 1);
  const changed = await service.store({ userId: "alice", access: "public", bytes: Buffer.concat([bytes, Buffer.from("changed metadata")]), mimeType: "image/webp" });
  assert.notEqual(changed.key, results[0]!.key);
});

test("owner existence is checked before writing bytes", async () => {
  const before = writes;
  await assert.rejects(service.store({ userId: "missing", access: "public", bytes: Buffer.from("image"), mimeType: "image/png" }), /owner|account/i);
  assert.equal(writes, before);
});

test("verified staging aliases survive source cleanup and cannot be rebound to different bytes", async () => {
  const first = await service.store({ userId: "alice", access: "public", bytes: Buffer.from("first upload"), mimeType: "image/png" });
  const second = await service.store({ userId: "alice", access: "public", bytes: Buffer.from("different upload"), mimeType: "image/png" });
  await service.rememberUpload("alice", "public", "worlds/owned/thumbnail/source.png", first.sourceSha256);
  assert.deepEqual(await service.findUpload("alice", "public", "worlds/owned/thumbnail/source.png"), first);
  assert.equal(await service.findUpload("bob", "public", "worlds/owned/thumbnail/source.png"), undefined);
  await assert.rejects(service.rememberUpload("alice", "public", "worlds/owned/thumbnail/source.png", second.sourceSha256), /changed|conflict/i);
});


test("active image MIME cannot gain public execution through the master registry", async () => {
 const before=writes;
 await assert.rejects(service.store({userId:"alice",access:"public",bytes:Buffer.from("<svg onload='alert(1)'/>"),mimeType:"image/svg+xml"}),/invalid|unsupported/i);
 assert.equal(writes,before);
});


test("central public ingestion corrects archive-like MIME guesses while private and declared-active inputs stay strict",async()=>{
 const bytes=await sharp({create:{width:2,height:3,channels:4,background:"#12345678"}}).withMetadata().png().toBuffer();
 const master=await service.store({userId:"alice",access:"public",bytes,mimeType:"image/jpeg"});
 assert.equal(master.mimeType,"image/png");assert.equal(mimes.get(master.key),"image/png");assert.deepEqual(objects.get(master.key),bytes);assert.equal(master.sourceSha256,digest(bytes));
 const before=writes;
 await assert.rejects(service.store({userId:"alice",access:"private",bytes,mimeType:"image/jpeg"}),/content type|format/i);
 await assert.rejects(service.store({userId:"alice",access:"public",bytes,mimeType:"image/svg+xml"}),/invalid|unsupported/i);
 assert.equal(writes,before);
});
