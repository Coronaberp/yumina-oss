import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { before, beforeEach, after, test } from "node:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { transform } from "sucrase";
import sharp from "sharp";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { createImageMasterService, ImageMasterError, isImageMasterKey } from "../lib/image-master-service.js";
import { encodeImageMaster, decodeImageMaster, type ImageMasterWriteOptions } from "../lib/image-master-envelope.js";
import { normalizeImportedImage, ImageImportPolicyError } from "../lib/image-import.js";
import { apngFixture } from "../test/image-master-fixtures.js";

const client = new PGlite(), db = drizzle(client) as unknown as DrizzleDB;
const objects = new Map<string, { bytes: Buffer; contentType: string; metadata?: ImageMasterWriteOptions }>();
let actor: string | null = "owner", transfers = 0, masterWrites = 0, reads = 0;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const url = (key: string) => `/cdn/key/${Buffer.from(key).toString("base64url")}`;
const imageMasters = createImageMasterService(db, { encode: encodeImageMaster, write: async (key, bytes, contentType, metadata) => {
  masterWrites++; objects.set(key, { bytes: Buffer.from(bytes), contentType, metadata });
} });
const routeFile = new URL("./studio.ts", import.meta.url), require = createRequire(routeFile);
const module = { exports: {} as { studioRoutes: Hono } };
const mocks: Record<string, unknown> = {
  "../db/index.js": { db },
  "../middleware/auth.js": { authMiddleware: async (c: any, next: () => Promise<void>) => {
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", { id: actor }); await next();
  } },
  "../lib/s3.js": { isS3Configured: () => true, generateUploadUrl: async (key: string) => { transfers++; return `storage://${key}`; },
    getObjectBuffer: async (key: string, options?: { maxBytes?: number; signal?: AbortSignal }) => {
      reads++; options?.signal?.throwIfAborted(); const object = objects.get(key); assert.ok(object, `Missing fixture object: ${key}`);
      const buffer = await decodeImageMaster(object.bytes, { ...object.metadata, contentType: object.contentType }, options);
      if (options?.maxBytes !== undefined && buffer.length > options.maxBytes) throw Error("Object too large");
      return { buffer, contentType: object.contentType };
    } },
  "../lib/image-masters.js": { imageMasters, ImageMasterError, isImageMasterKey, validSourceSha256: (value: unknown) => value === undefined || typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) },
  "../lib/image-import.js": { normalizeImportedImage, ImageImportPolicyError },
  "../lib/cdn-url.js": { resolveImageCdn: url },
  "../lib/studio-tools/index.js": {}, "../lib/studio-skills/index.js": {},
  "../lib/studio-world-material.js": {}, "../lib/studio-credit-checkpoint.js": {},
  "../lib/studio-conversations.js": {}, "../lib/pending-edit.js": {},
  "../lib/studio-tools/asset-catalog.js": {}, "../lib/studio-tools/project-intelligence.js": {},
};
new Function("require", "module", "exports", transform(readFileSync(routeFile, "utf8"), { transforms: ["typescript", "imports"] }).code)(
  (id: string) => mocks[id] ?? require(id), module, module.exports);
const app = new Hono(); app.route("/studio", module.exports.studioRoutes);
before(async () => { await client.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES(\'owner\'),(\'other\');'); await client.exec(IMAGE_MASTERS_DDL); });
beforeEach(async () => { await client.exec("DELETE FROM image_master_uploads; DELETE FROM image_masters;"); objects.clear(); actor = "owner"; transfers = 0; masterWrites = 0; reads = 0; });
after(async () => { await client.close(); });
const request = (path: string, body: unknown) => app.request(`/studio/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function source() {
  return sharp({ create: { width: 12, height: 10, channels: 4, background: "#12345680" } })
    .withExif({ IFD0: { ImageDescription: "retain exact Studio source metadata" } }).png({ compressionLevel: 0 }).toBuffer();
}
const input = (bytes: Buffer) => ({ filename: "original.png", contentType: "image/png", fileSize: bytes.length, sourceSha256: hash(bytes), requestId: "a1111111-1111-4111-8111-111111111111" });
async function prepareAndPut(bytes: Buffer) {
  const body = input(bytes), response = await request("upload-url", body); assert.equal(response.status, 200);
  const prepared = (await response.json() as any).data;
  assert.equal(typeof prepared.uploadUrl, "string");
  objects.set(prepared.key, { bytes: Buffer.from(bytes), contentType: "image/png" });
  return { ...body, key: prepared.key };
}

test("Studio confirmation verifies exact original bytes and returns one reusable master with independent names", async () => {
  const bytes = await source(), upload = await prepareAndPut(bytes);
  const response = await request("upload-confirm", upload); assert.equal(response.status, 200);
  const first = (await response.json() as any).data;
  assert.match(first.key, /^users\/owner\/image-masters\/public\/[a-f0-9]{64}\.png$/);
  assert.equal(first.name, "original.png"); assert.equal(first.mimeType, "image/png"); assert.equal(first.url, url(first.key));
  const stored = objects.get(first.key)!;
  assert.deepEqual(await decodeImageMaster(stored.bytes, { ...stored.metadata, contentType: stored.contentType }), bytes);
  const reused = await request("upload-url", { ...input(bytes), filename: "second-name.png" }); assert.equal(reused.status, 200);
  assert.deepEqual((await reused.json() as any).data, { key: first.key, reused: true }); assert.equal(transfers, 1);
  const second = await request("upload-confirm", { ...input(bytes), key: first.key, filename: "second-name.png" });
  assert.equal(second.status, 200); const attachment = (await second.json() as any).data;
  assert.equal(attachment.key, first.key); assert.equal(attachment.name, "second-name.png"); assert.equal(masterWrites, 1);
});

test("Studio master confirmation preserves JPEG, GIF and animated WebP file bytes", async () => {
  const pixels = Buffer.alloc(8 * 16 * 4, 100); pixels.fill(220, 8 * 8 * 4);
  const fixtures = [
    { bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "gold" } }).withExif({ IFD0: { ImageDescription: "retain original JPEG metadata" } }).jpeg().toBuffer(), mimeType: "image/jpeg" },
    { bytes: await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ delay: [100, 200], loop: 3 }).toBuffer(), mimeType: "image/gif" },
    { bytes: await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ lossless: true, delay: [120, 230], loop: 2 }).toBuffer(), mimeType: "image/webp" },
  ];
  for (const fixture of fixtures) {
    const body = { ...input(fixture.bytes), contentType: fixture.mimeType, requestId: crypto.randomUUID() };
    const prepared = await request("upload-url", body); assert.equal(prepared.status, 200);
    const upload = (await prepared.json() as any).data;
    objects.set(upload.key, { bytes: fixture.bytes, contentType: fixture.mimeType });
    const confirmed = await request("upload-confirm", { ...body, key: upload.key }); assert.equal(confirmed.status, 200);
    const attachment = (await confirmed.json() as any).data, stored = objects.get(attachment.key)!;
    assert.equal(attachment.mimeType, fixture.mimeType);
    assert.deepEqual(await decodeImageMaster(stored.bytes, { ...stored.metadata, contentType: stored.contentType }), fixture.bytes);
  }
  assert.equal(masterWrites, 3);
});

test("unsupported APNG attachments report a clear policy error without flattening or creating a master", async () => {
  const bytes = apngFixture(), upload = await prepareAndPut(bytes);
  const response = await request("upload-confirm", upload); assert.equal(response.status, 400);
  assert.match((await response.json() as any).error, /Animated PNG.*not supported.*Studio/i);
  assert.equal(masterWrites, 0);
});

test("wrong hashes, MIME mismatch and invalid raster data cannot create a Studio master", async () => {
  const bytes = await source(), upload = await prepareAndPut(bytes);
  assert.equal((await request("upload-confirm", { ...upload, sourceSha256: "0".repeat(64) })).status, 409);
  assert.equal(masterWrites, 0);
  assert.equal((await request("upload-confirm", { ...upload, contentType: "image/jpeg" })).status, 409);
  const invalid = Buffer.from("<svg>active format</svg>");
  objects.set(upload.key, { bytes: invalid, contentType: "image/png" });
  assert.equal((await request("upload-confirm", { ...upload, fileSize: invalid.length, sourceSha256: undefined })).status, 400);
  assert.equal(masterWrites, 0);
});

test("forged, foreign and private master references are denied before image reads", async () => {
  const bytes = await source(), upload = await prepareAndPut(bytes);
  actor = "other";
  assert.equal((await request("upload-confirm", upload)).status, 403); assert.equal(reads, 0);
  actor = "owner";
  for (const key of [`users/owner/image-masters/public/${"a".repeat(64)}.png`, `users/other/image-masters/public/${"a".repeat(64)}.png`, `private-session-media/owner/image-masters/private/${"a".repeat(64)}.png`]) {
    assert.equal((await request("upload-confirm", { ...input(bytes), key })).status, 403);
    assert.equal((await request("download-url", { key })).status, 403);
  }
  assert.equal(reads, 0);
});

test("download URLs preserve legacy ownership and require exact registry ownership for masters", async () => {
  const legacy = "studio-chat/owner/12345678-1234-4234-8234-123456789abc.png";
  const old = await request("download-url", { key: legacy }); assert.equal(old.status, 200); assert.deepEqual((await old.json() as any).data, { url: url(legacy) });
  const bytes = await source(), upload = await prepareAndPut(bytes);
  const confirmed = await request("upload-confirm", upload); assert.equal(confirmed.status, 200);
  const attachment = (await confirmed.json() as any).data;
  assert.equal((await request("download-url", { key: attachment.key })).status, 200);
  actor = "other"; assert.equal((await request("download-url", { key: attachment.key })).status, 403);
  actor = null; assert.equal((await request("upload-url", input(bytes))).status, 401);
});

test("confirmation retries reconcile after the staging object disappears without a second master write", async () => {
  const bytes = await source(), upload = await prepareAndPut(bytes);
  const first = await request("upload-confirm", upload); assert.equal(first.status, 200); const attachment = (await first.json() as any).data;
  objects.delete(upload.key);
  const retried = await request("upload-confirm", upload); assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json() as any).data, attachment); assert.equal(masterWrites, 1); assert.equal(transfers, 1);
});

test("Studio keeps its existing ten MiB and raster format bounds", async () => {
  for (const body of [
    { filename: "a.png", contentType: "image/png", fileSize: 10 * 1024 * 1024 + 1 },
    { filename: "a.png", contentType: "image/png", fileSize: 0 },
    { filename: "a.svg", contentType: "image/svg+xml", fileSize: 10 },
    { filename: "a.png", contentType: "image/png", fileSize: 10, sourceSha256: "not-a-digest" },
  ]) assert.equal((await request("upload-url", body)).status, 400);
  assert.equal(transfers, 0); assert.equal(reads, 0);
});
