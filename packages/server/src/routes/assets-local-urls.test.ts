import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { user, worlds, worldPendingEdits } from "../db/schema.js";
import { assets } from "../db/schema.js";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { getLocalDiskStorage } from "../lib/s3.js";
import { assetRoutes } from "./assets.js";
import { worldRoutes } from "./worlds.js";
import type { AppEnv } from "../lib/types.js";

test("world asset upload and listing use browser-relative local URLs", async () => {
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Local assets", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Local assets", schema: {} });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const pattern of ["/worlds/:worldId/assets/upload-url", "/worlds/:worldId/assets"]) {
    for (const route of assetRoutes.routes.filter(r => r.path === pattern)) app.on(route.method, pattern, route.handler);
  }
  const assetPath = `/worlds/${worldId}/assets`;
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const prepared = await post(`${assetPath}/upload-url`, { filename: "test.txt", type: "txt", contentType: "text/plain" });
  assert.equal(prepared.status, 200);
  const upload = (await prepared.json() as { data: { key: string; uploadUrl: string } }).data;
  assert.ok(upload.uploadUrl.startsWith("/storage/upload?token="));
  const registered = await post(assetPath, { key: upload.key, filename: "test.txt", type: "txt", mimeType: "text/plain", sizeBytes: 1 });
  assert.equal(registered.status, 201);
  const asset = (await registered.json() as { data: { id: string; url: string } }).data;
  assert.equal(asset.url, `/cdn/${asset.id}`);
  const listed = await app.request(assetPath);
  assert.equal(listed.status, 200);
  const rows = (await listed.json() as { data: Array<{ id: string; url: string }> }).data;
  assert.equal(rows.find(row => row.id === asset.id)!.url, `/cdn/${asset.id}`);
});

test("covers and gallery uploads use lossless WebP and reconcile confirmations after staging cleanup", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Lossless covers", email: `${uid}@test.local` });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  const coverPath = "/worlds/:worldId/thumbnail/confirm";
  const galleryPath = "/:id/gallery/confirm";
  app.on("POST", coverPath, assetRoutes.routes.filter(r => r.path === coverPath && r.method === "POST").at(-1)!.handler);
  app.on("POST", galleryPath, worldRoutes.routes.filter(r => r.path === galleryPath && r.method === "POST").at(-1)!.handler);
  const storage = getLocalDiskStorage();
  const input = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#abcdef80" } }).png({ compressionLevel: 0 }).toBuffer();
  const post = (path: string, key: string) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  for (const status of ["draft", "published"] as const) {
    const worldId = crypto.randomUUID();
    await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Lossless covers", schema: { id: worldId, version: "20.0.0", name: "Lossless covers", firstMessage: "", entries: [], variables: [], rules: [] }, status });
    const key = `worlds/${worldId}/thumbnail/source.png`;
    await storage.putObject(key, input, "image/png");
    const response = await post(`/worlds/${worldId}/thumbnail/confirm`, key);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal((body as {data:{heldForReview:boolean}}).data.heldForReview, status === "published");
    const [row] = status === "published"
      ? await db.select({ key: worldPendingEdits.thumbnailUrl }).from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId))
      : await db.select({ key: worlds.thumbnailUrl }).from(worlds).where(eq(worlds.id, worldId));
    assert.match(row!.key!, /\.webp$/);
    await assert.rejects(storage.headObject(key));
    assert.equal((await storage.headObject(row!.key!)).contentType, "image/webp");
    // A committed confirmation reconciles without any storage reads, including
    // during an outage after the source has already been removed.
    const originalRead = storage.getObjectBuffer;
    storage.getObjectBuffer = async () => { throw new Error("Storage outage"); };
    try {
      const retry = await post(`/worlds/${worldId}/thumbnail/confirm`, key);
      assert.equal(retry.status, 200, await retry.clone().text());
      assert.deepEqual(await retry.json(), body);
    } finally { storage.getObjectBuffer = originalRead; }
    const galleryKey = `worlds/${worldId}/gallery/source.png`;
    await storage.putObject(galleryKey, input, "image/png");
    const gallery = await post(`/${worldId}/gallery/confirm`, galleryKey);
    assert.equal(gallery.status, 200, await gallery.clone().text());
    const galleryBody = await gallery.json() as {data:{galleryImages:string[]}};
    assert.match(galleryBody.data.galleryImages[0]!, /\.webp$/);
    await assert.rejects(storage.headObject(galleryKey));
    assert.deepEqual(await (await post(`/${worldId}/gallery/confirm`, galleryKey)).json(), galleryBody);
  }
});

test("world image uploads register and serve lossless WebP with compressed storage metadata", async () => {
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Lossless assets", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Lossless assets", schema: {} });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of assetRoutes.routes.filter(r => r.path === "/worlds/:worldId/assets")) app.on(route.method, route.path, route.handler);
  const original = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#12345680" } }).png({ compressionLevel: 0 }).toBuffer();
  const key = `worlds/${worldId}/image/test.png`;
  const storage = getLocalDiskStorage();
  await storage.putObject(key, original, "image/png");
  const response = await app.request(`/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, filename: "test.png", type: "image", mimeType: "image/png", sizeBytes: 1 }) });
  assert.equal(response.status, 201, await response.clone().text());
  const asset = (await response.json() as { data: {id:string;filename:string;mimeType:string;sizeBytes:number} }).data;
  assert.equal(asset.filename, "test.webp");
  assert.equal(asset.mimeType, "image/webp");
  const [stored] = await db.select().from(assets).where(eq(assets.id, asset.id));
  assert.match(stored!.url, /\.webp$/);
  const object = await storage.getObjectBuffer(stored!.url);
  assert.equal(object.contentType, "image/webp");
  assert.equal(object.buffer.length, asset.sizeBytes);
  assert.ok(asset.sizeBytes < original.length);
  assert.deepEqual(await sharp(object.buffer).raw().toBuffer(), await sharp(original).raw().toBuffer());
  const retried = await app.request(`/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, filename: "test.png", type: "image", mimeType: "image/png", sizeBytes: 1 }) });
  assert.equal(retried.status, 201, await retried.clone().text());
  assert.equal((await retried.json() as {data:{id:string}}).data.id, asset.id);
});
