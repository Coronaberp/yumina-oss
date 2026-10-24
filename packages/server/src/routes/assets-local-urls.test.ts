import "../test/database-fixture.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db, ensureImageMasterTables } from "../db/index.js";
import { user, worlds, worldPendingEdits } from "../db/schema.js";
import { assets } from "../db/schema.js";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { getLocalDiskStorage } from "../lib/s3.js";
import { createHash } from "node:crypto";
import { ImageMasterError } from "../lib/image-masters.js";
import { assetRoutes } from "./assets.js";
import { worldRoutes } from "./worlds.js";
import type { AppEnv } from "../lib/types.js";

after(async () => { if ("close" in db.$client && !db.$client.closed) await db.$client.close(); });

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

test("covers and gallery uploads preserve original files and reconcile confirmations after staging cleanup", async () => {
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
    assert.match(row!.key!, /\/image-masters\/public\/[a-f0-9]{64}\.png$/);
    assert.deepEqual((await storage.getObjectBuffer(row!.key!)).buffer,input);
    await assert.rejects(storage.headObject(key));
    assert.equal((await storage.headObject(row!.key!)).contentType, "image/png");
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
    assert.equal(galleryBody.data.galleryImages[0]!, row!.key, "cover and gallery bind independently to one original master");
    await assert.rejects(storage.headObject(galleryKey));
    assert.deepEqual(await (await post(`/${worldId}/gallery/confirm`, galleryKey)).json(), galleryBody);
  }
});

test("world image uploads register and serve byte-exact originals with matching metadata", async () => {
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Lossless assets", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Lossless assets", schema: {} });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of assetRoutes.routes.filter(r => r.path === "/worlds/:worldId/assets")) app.on(route.method, route.path, route.handler);
  const original = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#12345680" } }).png({ compressionLevel: 0 }).toBuffer();
  const key = `worlds/${worldId}/image/test.jpg`;
  const storage = getLocalDiskStorage();
  await storage.putObject(key, original, "image/jpeg");
  const response = await app.request(`/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, filename: "test.jpg", type: "image", mimeType: "image/jpeg", sizeBytes: 1 }) });
  assert.equal(response.status, 201, await response.clone().text());
  const asset = (await response.json() as { data: {id:string;filename:string;mimeType:string;sizeBytes:number} }).data;
  assert.equal(asset.filename, "test.jpg");
  assert.equal(asset.mimeType, "image/png");
  const [stored] = await db.select().from(assets).where(eq(assets.id, asset.id));
  assert.match(stored!.url, /\/image-masters\/public\/[a-f0-9]{64}\.png$/);
  const object = await storage.getObjectBuffer(stored!.url);
  assert.equal(object.contentType, "image/png");
  assert.equal(object.buffer.length, asset.sizeBytes);
  assert.equal(asset.sizeBytes, original.length);
  assert.deepEqual(object.buffer, original);
  const retried = await app.request(`/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, filename: "test.jpg", type: "image", mimeType: "image/jpeg", sizeBytes: 1 }) });
  assert.equal(retried.status, 201, await retried.clone().text());
  assert.equal((await retried.json() as {data:{id:string}}).data.id, asset.id);
});


test("world preflight reuse keeps independent logical rows and deletion preserves sibling original", async () => {
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Reuse fixture", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: "Reuse fixture", schema: {} });
  const app = new Hono<AppEnv>();
  app.use("*", async(c,next)=>{c.set("user",{id:uid} as AppEnv["Variables"]["user"]);await next();});
  app.onError((error,c)=>error instanceof ImageMasterError?c.json({error:error.message},error.status):c.json({error:"fixture failed"},500));
  for(const r of assetRoutes.routes.filter(r=>r.path.startsWith("/worlds/:worldId/assets"))) if(r.path!=="/*") app.on(r.method,r.path,r.handler);
  for(const r of assetRoutes.routes.filter(r=>r.path==="/worlds/:worldId/thumbnail"))app.on(r.method,r.path,r.handler);
  const galleryPrepare=worldRoutes.routes.filter(r=>r.path==="/:id/gallery/upload-url"&&r.method==="POST").at(-1)!;app.on("POST",galleryPrepare.path,galleryPrepare.handler);
  const path=`/worlds/${worldId}/assets`,post=(url:string,body:unknown)=>app.request(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const bytes=await sharp({create:{width:10,height:8,channels:4,background:"#12345678"}}).withMetadata().png().toBuffer();
  const sourceSha256=createHash("sha256").update(bytes).digest("hex");
  const firstRequest={filename:"first.png",type:"image",contentType:"image/png",requestId:crypto.randomUUID(),sourceSha256};
  const p=await post(`${path}/upload-url`,firstRequest);assert.equal(p.status,200);const prepared=(await p.json() as {data:{key:string}}).data;
  await getLocalDiskStorage().putObject(prepared.key,bytes,"image/png");
  const firstResponse=await post(path,{...firstRequest,key:prepared.key,mimeType:"image/png",sizeBytes:bytes.length});assert.equal(firstResponse.status,201,await firstResponse.clone().text());
  const first=(await firstResponse.json() as {data:{id:string}}).data;
  const secondRequest={...firstRequest,filename:"different.jpeg",contentType:"image/jpeg",requestId:crypto.randomUUID()};
  const reused=(await (await post(`${path}/upload-url`,secondRequest)).json() as {data:{key:string;reused:boolean;uploadUrl?:string}}).data;
  assert.equal(reused.reused,true);assert.equal(reused.uploadUrl,undefined);
  const secondResponse=await post(path,{...secondRequest,key:reused.key,mimeType:"image/jpeg",sizeBytes:bytes.length});assert.equal(secondResponse.status,201);
  const second=(await secondResponse.json() as {data:{id:string;filename:string}}).data;assert.notEqual(second.id,first.id);assert.equal(second.filename,"different.jpeg");
  assert.equal((await app.request(`${path}/${first.id}`,{method:"DELETE"})).status,200);
  assert.deepEqual((await getLocalDiskStorage().getObjectBuffer(reused.key)).buffer,bytes);
  for(const endpoint of [`/worlds/${worldId}/thumbnail`,`/${worldId}/gallery/upload-url`]){
    const hit=await post(endpoint,{filename:"same-bytes.jpg",contentType:"image/jpeg",sourceSha256,sizeBytes:bytes.length});assert.equal(hit.status,200,await hit.clone().text());
    const value=(await hit.json() as {data:{key:string;reused:boolean}}).data;assert.equal(value.reused,true);assert.equal(value.key,reused.key);
    assert.equal((await post(endpoint,{filename:"same-bytes.jpg",contentType:"image/jpeg",sourceSha256,sizeBytes:bytes.length+1})).status,409);
  }
});


test("image master bootstrap is idempotent through the real prepared DB facade", async () => {
 await ensureImageMasterTables(); await ensureImageMasterTables();
});
