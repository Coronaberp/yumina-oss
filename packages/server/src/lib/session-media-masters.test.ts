import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { deflateSync, gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import sharp from "sharp";
import type { DrizzleDB } from "../db/index.js";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { prepareSessionImage } from "./session-media-image.js";
import { createSessionMediaService } from "./session-media-service.js";
import { createImageMasterService } from "./image-master-service.js";
import { encodeImageMaster } from "./image-master-envelope.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type),data]); let crc = 0xffffffff;
  for (const value of body) { crc ^= value; for (let bit=0;bit<8;bit++) crc = (crc>>>1) ^ ((crc&1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([size,body,checksum]);
}
test("private policy rejects APNG instead of accepting its first frame, and retains the existing GIF restriction", async () => {
  const header = Buffer.alloc(13); header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2,0);
  const frame = (sequence:number) => { const data=Buffer.alloc(26); data.writeUInt32BE(sequence,0); data.writeUInt32BE(1,4); data.writeUInt32BE(1,8); data.writeUInt16BE(1,20); data.writeUInt16BE(10,22); return pngChunk("fcTL",data); };
  const sequence=Buffer.alloc(4); sequence.writeUInt32BE(2);
  const apng = Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),pngChunk("IHDR",header),pngChunk("acTL",animation),frame(0),
    pngChunk("IDAT",deflateSync(Buffer.from([0,255,0,0,255]))),frame(1),
    pngChunk("fdAT",Buffer.concat([sequence,deflateSync(Buffer.from([0,0,0,255,255]))])),pngChunk("IEND",Buffer.alloc(0))]);
  assert.equal((await sharp(apng,{animated:true}).metadata()).pages, undefined, "decoder metadata alone does not identify this animation");
  await assert.rejects(prepareSessionImage(apng),/MEDIA_UNSUPPORTED_IMAGE/);
  const gif = await sharp({create:{width:1,height:1,channels:4,background:"red"}}).gif().toBuffer();
  await assert.rejects(prepareSessionImage(gif),/MEDIA_UNSUPPORTED_IMAGE/);
});

test("private preparation retains complete static source bytes, profiles, alpha and high depth", async () => {
  const image = () => sharp({ create: { width: 16, height: 12, channels: 4, background: "#12345680" } });
  const fixtures = [
    await image().withExif({ IFD0: { ImageDescription: "Synthetic original metadata" } }).png().toBuffer(),
    await image().withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    await image().webp({ lossless: true }).toBuffer(),
    await image().toColourspace("rgb16").png().toBuffer(),
  ];
  for (const input of fixtures) {
    const before = Buffer.from(input), result = await prepareSessionImage(input);
    assert.deepEqual(result.main, before, "main is the complete original file, never a raster transcode");
    assert.equal(result.hash, sha(before));
    assert.deepEqual(input, before);
    const oriented = (await sharp(input).metadata()).autoOrient;
    assert.equal(result.width, oriented.width); assert.equal(result.height, oriented.height);
    assert.equal((await sharp(result.thumbnail).metadata()).format, "webp");
    assert.ok(result.thumbnail.length <= 128 * 1024);
  }
});

test("private preparation preserves accepted animated WebP frames, timing and loop bytes", async () => {
  const pixels = Buffer.alloc(8 * 16 * 4, 80); pixels.fill(200, 8 * 8 * 4);
  const input = await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
    .webp({ lossless: true, delay: [120, 230], loop: 2 }).toBuffer();
  const result = await prepareSessionImage(input);
  assert.deepEqual(result.main, input);
  const metadata = await sharp(result.main, { animated: true }).metadata();
  assert.equal(metadata.pages, 2); assert.deepEqual(metadata.delay, [120, 230]); assert.equal(metadata.loop, 2);
  assert.equal(result.height, 8, "gallery dimensions describe one frame, not a stacked decode");
  const tooManyPixels = Buffer.from(input);
  // Decoder still validates the full animated input; unsupported bytes never become masters.
  await assert.rejects(prepareSessionImage(tooManyPixels.subarray(0, 20)));
});

test("private masters retain original MIME/name, isolate access, share bytes and survive logical deletion", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE user_assets(id text PRIMARY KEY,user_id text,size_bytes bigint,url text);
      CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,world_id text,name text,parent_session_id text,branched_from_message_id text);
      CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
      CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text,name text);
      CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text,title text);
      INSERT INTO "user" VALUES ('alice'),('bob');
      INSERT INTO play_sessions VALUES ('save','alice','world','Save',NULL,NULL),('bob-save','bob','world','Bob',NULL,NULL);`);
    await pg.exec(SESSION_MEDIA_DDL); await pg.exec(IMAGE_MASTERS_DDL);
    const database = drizzle(pg) as unknown as DrizzleDB;
    const objects = new Map<string, Buffer>(), writes: string[] = [], signed: Array<[string,string | undefined]> = [];
    const masters = createImageMasterService(database, { encode: encodeImageMaster,
      write: async (key, bytes, _mime, options) => { writes.push(key); objects.set(key, options.contentEncoding ? gunzipSync(bytes) : bytes); } });
    const service = createSessionMediaService(database, {
      signUpload: async key => key,
      signRead: async (key, mime) => { signed.push([key,mime]); return `signed:${key}`; },
      read: async key => { assert.ok(objects.has(key)); return objects.get(key)!; },
      write: async (key, bytes) => { writes.push(key); objects.set(key, bytes); },
      remove: async key => { objects.delete(key); },
    }, masters);
    const input = await sharp({ create: { width: 8, height: 6, channels: 4, background: "#12345680" } })
      .withExif({ IFD0: { ImageDescription: "private metadata" } }).png().toBuffer();
    const pub = await masters.store({ userId: "alice", access: "public", bytes: input, mimeType: "image/png" });
    const upload = async (owner: string, entryId: string, filename = "original.png", bytes = input, mime = "image/png") => {
      const request = { id: randomUUID(), sessionId: owner === "alice" ? "save" : "bob-save", entryId, filename, contentType: mime, size: bytes.length };
      const reserved = await service.reserve(owner, request); objects.set(reserved.uploadUrl!, bytes);
      return service.complete(owner, request.id);
    };
    const one = await upload("alice", "one"), two = await upload("alice", "two", "other-name.png");
    assert.equal(one.mediaId, two.mediaId);
    const rows = await pg.query<{object_key:string;filename:string;hash:string}>("SELECT object_key,filename,hash FROM session_media WHERE user_id='alice'");
    const row = rows.rows[0]!;
    assert.equal(row.filename, "original.png"); assert.equal(row.hash, sha(input));
    assert.notEqual(row.object_key, pub.key); assert.equal(isPublicCdnKey(row.object_key), false);
    assert.deepEqual(objects.get(row.object_key), input);
    assert.equal(writes.filter(key => key === row.object_key).length, 1, "retry and sibling entries do not PUT the master again");
    await service.detail("alice", one.mediaId!);
    assert.ok(signed.some(([key,mime]) => key === row.object_key && mime === "image/png"));
    await assert.rejects(service.detail("bob", one.mediaId!), /MEDIA_NOT_FOUND/);
    const foreign = await upload("bob", "other"); assert.notEqual(foreign.mediaId, one.mediaId);
    const mismatch = await service.reserve("alice", { id: randomUUID(), sessionId: "save", entryId: "bad", filename: "bad.jpg", contentType: "image/jpeg", size: input.length });
    objects.set(mismatch.uploadUrl!, input);
    await assert.rejects(service.complete("alice", mismatch.id), /MEDIA_FORMAT_MISMATCH/);
    const detail = await service.detail("alice", one.mediaId!);
    await service.remove("alice", one.mediaId!, detail.revision);
    assert.deepEqual(objects.get(row.object_key), input, "logical revocation retains shared immutable masters for sibling uses");
    const replacement = await upload("alice", "later");
    assert.notEqual(replacement.mediaId, one.mediaId, "revocation does not revive an old logical record");
    assert.equal(writes.filter(key => key === row.object_key).length, 1, "new logical media reuses retained original bytes");
    const replacementRow = (await pg.query<{thumbnail_key:string}>("SELECT thumbnail_key FROM session_media WHERE status='ready' AND user_id='alice'" )).rows[0]!;
    await pg.exec("UPDATE session_media_uploads SET expires_at=now()-interval '1 hour'");
    await service.sweep();
    assert.deepEqual(objects.get(row.object_key), input, "attempt cleanup never sweeps canonical masters");
    assert.ok(objects.has(replacementRow.thumbnail_key), "attempt cleanup retains the thumbnail belonging to a ready logical record");
    assert.deepEqual(objects.get(pub.key), input);
  } finally { await pg.close(); }
});
