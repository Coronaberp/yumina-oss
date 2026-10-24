import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import type { Hono, Context } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import { createSessionMediaService } from "../lib/session-media-service.js";
import { uploadOperationId } from "../lib/asset-upload-operation.js";
import sharp from "sharp";
import { encodeImageMaster } from "../lib/image-master-envelope.js";
import { createImageMasterService, ImageMasterError, isImageMasterKey, validSourceSha256 } from "../lib/image-master-service.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { gunzipSync } from "node:zlib";
import type { AppEnv } from "../lib/types.js";

// Actual route and PostgreSQL semantics, with no runtime database/env import.
// Only auth, entitlement lookup and object transport cross mocked boundaries.
let owner = "alice", signedUrls = 0;
let backend: "local" | "s3" = "local", copies = 0, headCalls = 0;
let alterCopiedMime = false;
const client = new PGlite();
const database = { db: drizzle(client) as unknown as DrizzleDB };
const objects = new Map<string, {contentType:string;contentLength:number;etag:string;buffer?:Buffer;contentEncoding?:"gzip"}>();
const imageMasters = createImageMasterService(database.db, {
  encode: encodeImageMaster,
  write: async (key, buffer, contentType, opts) => objects.set(key, { buffer, contentType, contentLength: buffer.length, etag: opts.storedSha256, contentEncoding: opts.contentEncoding }) as unknown as void,
});
const service = createSessionMediaService(database.db, {
  signUpload: async key => key, signRead: async key => key,
  read: async () => Buffer.alloc(0), write: async () => {},
  remove: async key => { objects.delete(key); },
});
const file = new URL("./user-assets.ts", import.meta.url);
const require = createRequire(file);
const module = { exports: {} as { userAssetRoutes: Hono<AppEnv> } };
const mocks: Record<string, unknown> = {
  "../db/index.js": database,
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); } },
  "../lib/s3.js": {
    isS3Configured: () => true, storageKind: () => backend,
    generateUploadUrl: async (_key:string, _mime:string, options?:{contentLength:number;expiresIn:number}) => {
      signedUrls++;
      if (backend === "s3") {
        assert.ok(options && options.contentLength > 0);
        assert.ok(options.expiresIn > 0 && options.expiresIn <= 600);
      }
      return "https://storage.test/upload";
    },
    headObject: async (key:string) => {
      headCalls++;
      const object = objects.get(key);
      assert.ok(object, "HEAD must inspect an uploaded object");
      return object;
    },
    copyObject: async (source:string, destination:string, etag?:string, expected?:{contentLength:number;contentType:string}) => {
      const object = objects.get(source);
      assert.ok(object);
      assert.equal(etag, object.etag, "copy must be conditional on inspected content");
      copies++;
      objects.set(destination, {...object, ...(alterCopiedMime ? {contentType:"text/html"} : {})});
      assert.deepEqual(expected, object, "registration supplies inspected metadata to the copy integrity check");
      if (objects.get(destination)!.contentType !== expected!.contentType) throw new Error("Copied object metadata changed");
    },
    deleteObject: async (key:string) => { objects.delete(key); },
  },
  "../lib/session-media.js": { sessionMedia: service },
  "../lib/env.js": { env: { BETTER_AUTH_URL: "https://yumina.test" } },
  "../lib/image-masters.js": { imageMasters, ImageMasterError, isImageMasterKey, validSourceSha256,
    storeUploadedImage: async (asset: {userId:string;key:string;mimeType:string;sourceSha256?:string}, tx: Pick<DrizzleDB,"execute">) => {
      if (isImageMasterKey(asset.key)) return imageMasters.findByKey(asset.userId,"public",asset.key,tx);
      return imageMasters.store({userId:asset.userId,access:"public",bytes:objects.get(asset.key)!.buffer!,mimeType:asset.mimeType,sourceSha256:asset.sourceSha256},tx);
    },
  },
  "../lib/generation/asset-receipts.js": { detachGenerationAsset: async () => {} },
};
new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
const routes = module.exports.userAssetRoutes;
before(async () => {
  assert.ok(client instanceof PGlite);
  await client.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY);
    INSERT INTO "user" VALUES ('alice'),('bob'),('charlie'),('dana'),('erin'),('frank'),('image-local'),('image-private');
    CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,parent_session_id text,branched_from_message_id text);
    CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
    CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text);
    CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text);
    CREATE TABLE asset_folders (id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, parent_folder_id text, created_at timestamp DEFAULT now());
    CREATE TABLE user_assets (id text PRIMARY KEY, user_id text NOT NULL, type text NOT NULL, filename text NOT NULL, url text NOT NULL, size_bytes integer, mime_type text, folder_id text REFERENCES asset_folders(id), source_asset_id text, is_public boolean DEFAULT false, created_at timestamp DEFAULT now());
  `);
  await client.exec(IMAGE_MASTERS_DDL);
});

test("lossless image registration publishes matching metadata, settles compressed bytes and survives retries", async () => {
  const signedBefore = signedUrls;
  await client.exec(SESSION_MEDIA_DDL);
  try {
    for (const mode of ["local", "s3"] as const) {
      backend = mode; owner = mode === "local" ? "image-local" : "image-private";
      const input = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#12345680" } }).png({ compressionLevel: 0 }).toBuffer();
      const request = { filename: "sprite.png", type: "image", contentType: "image/png", sizeBytes: input.length };
      const prepared = await post("/upload-url", request);
      assert.equal(prepared.status, 200, await prepared.clone().text());
      const key = (await data(prepared)).key;
      objects.set(key, { buffer: input, contentType: "image/png", contentLength: input.length, etag: "original-image" });
      const body = { ...request, key, mimeType: "image/png" };
      const response = await post("/", body);
      assert.equal(response.status, 201, await response.clone().text());
      const asset = (await response.json() as { data: {id:string;key:string;filename:string;mimeType:string;sizeBytes:number} }).data;
      assert.equal(asset.filename, "sprite.png");
      assert.equal(asset.mimeType, "image/png");
      assert.match(asset.key, /\/image-masters\/public\/[a-f0-9]{64}\.png$/);
      assert.equal(asset.sizeBytes, input.length);
      assert.ok(objects.get(asset.key)!.contentLength <= asset.sizeBytes);
      assert.equal(objects.get(asset.key)!.contentType, asset.mimeType);
      const object = objects.get(asset.key)!;
      assert.deepEqual(object.contentEncoding === "gzip" ? gunzipSync(object.buffer!) : object.buffer, input);
      assert.equal((await service.usage(owner)).used, asset.sizeBytes);
      assert.equal((await service.usage(owner)).reserved, 0);
      const retry = await post("/", body);
      assert.equal(retry.status, 201, await retry.clone().text());
      assert.equal((await data(retry)).id, asset.id, "retry without a request ID must find the same original master");
    }
  } finally { backend = "local"; signedUrls = signedBefore; }
});
after(async () => { await client.close(); });
const post = (path: string, body: object) => routes.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const data = async (response: Response) => (await response.json() as { data: { id: string; key: string; url: string; asset?: { id: string } } }).data;

test("lost responses and concurrent retries produce one folder and asset regardless of account usage", async () => {
  owner = "alice";
  const folderRequest = { name: "clips", requestId: crypto.randomUUID() };
  const folders = await Promise.all([post("/folders", folderRequest), post("/folders", folderRequest)]);
  assert.ok(folders.every(response => response.status === 201));
  const folder = await data(folders[0]!);
  assert.equal((await data(folders[1]!)).id, folder.id);
  const request = { requestId: crypto.randomUUID(), filename: "scene.webm", type: "video", contentType: "", sizeBytes: 60 };
  const prepared = await post("/upload-url", request);
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const key = (await data(prepared)).key;
  objects.set(key, {contentType:"video/webm",contentLength:60,etag:"local-original"});
  const body = { ...request, key, mimeType: "video/webm", folderId: folder.id };
  const registered = await Promise.all([post("/", body), post("/", body)]);
  assert.ok(registered.every(response => response.status === 201));
  const asset = await data(registered[0]!);
  assert.equal(asset.url, `/cdn/${asset.id}`, "local thumbnails follow the browser origin rather than the configured HTTP host");
  assert.equal((await data(registered[1]!)).id, asset.id);
  // Treat the successful responses as lost; retry prepare at 60/100 used.
  const retried = await post("/upload-url", request);
  assert.equal(retried.status, 200);
  assert.equal((await data(retried)).asset?.id, asset.id);
  assert.equal(signedUrls, 1, "committed asset is reconciled without another storage transfer");
  const { rows } = await client.query<{ count: number; bytes: number }>("SELECT count(*)::int AS count, sum(size_bytes)::int AS bytes FROM user_assets WHERE user_id='alice'");
  assert.deepEqual(rows, [{ count: 1, bytes: 60 }]);
  assert.equal((await post("/upload-url", { ...request, requestId: crypto.randomUUID() })).status, 200, "new uploads are not blocked by account storage usage");
  owner = "bob";
  assert.equal((await post("/folders", { name: "private", parentFolderId: folder.id })).status, 404);
  assert.equal((await post("/", body)).status, 400, "another account cannot register the first owner's key");
  const other = await post("/upload-url", request);
  assert.equal(other.status, 200);
  const otherData = await data(other);
  assert.equal(otherData.asset, undefined);
  assert.notEqual(otherData.key, key);
});

test("video MIME checks reject active or unsupported content", async () => {
  owner = "charlie";
  for (const contentType of ["text/html", "video/quicktime"]) {
    const response = await post("/upload-url", { filename: "clip.mp4", type: "video", contentType });
    assert.equal(response.status, 400);
  }
  assert.equal((await post("/upload-url", { filename: "clip.MP4", type: "video", contentType: "application/octet-stream", sizeBytes: 1 })).status, 200);
});

test("staged retries reuse one reservation and settle one immutable asset using real bytes", async () => {
  await client.exec(SESSION_MEDIA_DDL);
  backend = "s3";
  owner = "dana";
  const request = {requestId:crypto.randomUUID(),filename:"scene.webm",type:"video",contentType:"video/webm",sizeBytes:60};
  const preparations = await Promise.all([post("/upload-url",request),post("/upload-url",request)]);
  assert.ok(preparations.every(response=>response.status===200));
  const key = (await data(preparations[0]!)).key;
  assert.equal((await data(preparations[1]!)).key,key,"lost prepare response reuses staged key");
  assert.ok(key.startsWith("private-session-media/dana/pending/"));
  assert.equal((await service.usage(owner)).reserved,60,"concurrent retries reserve bytes once");
  assert.equal((await post("/upload-url",{...request,filename:"different.webm"})).status,409);
  objects.set(key,{contentType:"video/webm",contentLength:60,etag:"staged-original"});
  const body = {...request,key,mimeType:"video/webm",sizeBytes:1};
  const beforeCopies = copies;
  const registered = await Promise.all([post("/",body),post("/",body)]);
  assert.ok(registered.every(response=>response.status===201),await registered[0]!.clone().text());
  const asset = await data(registered[0]!);
  assert.equal((await data(registered[1]!)).id,asset.id);
  assert.equal(asset.id,uploadOperationId(owner,"file",request.requestId));
  assert.equal(copies-beforeCopies,1,"concurrent confirmation makes only one final copy");
  assert.ok(asset.key.startsWith("users/dana/registered/"));
  assert.deepEqual(await service.usage(owner),{used:60,mediaBytes:0,reserved:0},"untrusted reported byte count is ignored");
  assert.equal((await post("/upload-url",{...request,requestId:crypto.randomUUID(),sizeBytes:50})).status,200);
  await client.exec(`UPDATE session_media_uploads SET expires_at=now()-interval '1 hour' WHERE user_id='dana'`);
  await service.sweep();
  assert.equal(objects.has(key),false);
  assert.equal(objects.has(asset.key),true,"cleanup keeps registered immutable file");
  const headsBeforeRetry = headCalls;
  assert.equal((await post("/",body)).status,201,"lost confirmation response survives temporary cleanup");
  assert.equal(headCalls,headsBeforeRetry,"completed confirmation does not HEAD cleaned staging object");
  assert.equal((await data(await post("/upload-url",request))).asset?.id,asset.id);
  await client.exec(`INSERT INTO session_media(id,user_id,filename,hash,object_key,thumbnail_key,size_bytes,width,height)
    VALUES ('private-dana','dana','private','private','private/main','private/thumb',30,1,1)`);
  assert.equal((await post("/upload-url",{...request,requestId:crypto.randomUUID(),sizeBytes:20})).status,200,"private media usage does not impose an account storage cap");
});

test("expired staging can retry with the same asset ID and changed object metadata cannot settle", async () => {
  owner = "erin";
  backend = "s3";
  const request = {requestId:crypto.randomUUID(),filename:"retry.webm",type:"video",contentType:"video/webm",sizeBytes:40};
  const original = await data(await post("/upload-url",request));
  await client.exec(`UPDATE session_media_uploads SET expires_at=now()-interval '1 hour' WHERE user_id='erin'`);
  await service.sweep();
  const retry = await data(await post("/upload-url",request));
  assert.notEqual(retry.key,original.key,"expired staging is replaced without extending old PUT access");
  assert.equal((await service.usage(owner)).reserved,40);
  const body = {...request,key:retry.key,mimeType:"video/webm"};
  objects.set(retry.key,{contentType:"video/webm",contentLength:41,etag:"size-mismatch"});
  assert.equal((await post("/",body)).status,409,"HEAD size must match reservation");
  objects.set(retry.key,{contentType:"text/html",contentLength:40,etag:"mime-mismatch"});
  assert.equal((await post("/",body)).status,400,"HEAD MIME must match prepared type");
  objects.set(retry.key,{contentType:"video/webm",contentLength:40,etag:"valid"});
  alterCopiedMime=true;
  try {
    assert.equal((await post("/",body)).status,500,"post-copy MIME mutation never becomes a public asset");
    assert.equal((await service.usage(owner)).used,0);
  } finally { alterCopiedMime=false; }
  const registered = await post("/",body);
  assert.equal(registered.status,201,await registered.clone().text());
  assert.equal((await data(registered)).id,uploadOperationId(owner,"file",request.requestId));
  assert.deepEqual(await service.usage(owner),{used:40,mediaBytes:0,reserved:0});
});

test("local creative uploads remain available after private media schema installation", async () => {
  owner = "frank";
  backend = "local";
  const request = {requestId:crypto.randomUUID(),filename:"local.webm",type:"video",contentType:"video/webm",sizeBytes:10};
  const prepared = await post("/upload-url",request);
  assert.equal(prepared.status,200,await prepared.clone().text());
  const key = (await data(prepared)).key;
  assert.ok(key.startsWith("users/frank/video/"));
  assert.equal((await service.usage(owner)).reserved,0);
  objects.set(key,{contentType:"video/webm",contentLength:12,etag:"local"});
  assert.equal((await post("/",{...request,key,mimeType:"video/webm"})).status,201);
  assert.equal((await service.usage(owner)).used,12,"local uploads also settle actual bytes");
});


// Hold each request after its real initial DB lookup has observed no asset.
// The winner can commit before the loser reaches the owner-locked recheck.
async function raceAfterInitialMiss(
  first: () => Response | Promise<Response>, second: () => Response | Promise<Response>,
): Promise<[Response, Response]> {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const entered = [deferred(), deferred()];
  const released = [deferred(), deferred()];
  const select = database.db.select;
  const transaction = database.db.transaction;
  const lockOwner = service.lockOwner;
  const find = imageMasters.find;
  const winnerLocked = deferred();
  const loserWaiting = deferred();
  const finishWinner = deferred();
  let transactions = 0;
  let locks = 0;
  let misses = 0;
  // Prepare must reach the locked reconciliation path, rather than returning
  // early because its digest happened to be reusable before the race settled.
  imageMasters.find = async () => undefined;
  database.db.transaction = ((...args: Parameters<typeof transaction>) => {
    if (++transactions === 2) loserWaiting.resolve();
    return Reflect.apply(transaction, database.db, args);
  }) as typeof transaction;
  service.lockOwner = async (...args: Parameters<typeof lockOwner>) => {
    await lockOwner(...args);
    if (++locks === 1) {
      winnerLocked.resolve();
      await finishWinner.promise;
    }
  };
  database.db.select = ((...args: Parameters<typeof select>) => {
    const builder = select.apply(database.db, args);
    const from = builder.from.bind(builder);
    builder.from = ((...fromArgs: Parameters<typeof from>) => {
      const query = from(...fromArgs);
      const limit = query.limit.bind(query);
      query.limit = (async (...limitArgs: Parameters<typeof limit>) => {
        const rows = await limit(...limitArgs);
        if (!rows.length && misses < 2) {
          const index = misses++;
          entered[index]!.resolve();
          await released[index]!.promise;
        }
        return rows;
      }) as typeof query.limit;
      return query;
    }) as typeof builder.from;
    return builder;
  }) as typeof select;
  let winner: Response | Promise<Response> | undefined;
  let loser: Response | Promise<Response> | undefined;
  try {
    winner = first();
    await entered[0]!.promise;
    loser = second();
    await entered[1]!.promise;
    released[0]!.resolve();
    await winnerLocked.promise;
    released[1]!.resolve();
    // PGlite queues transactions on its single connection. Confirm the loser
    // is waiting for that transaction before allowing the owner lock to clear.
    await loserWaiting.promise;
    finishWinner.resolve();
    const result = await winner;
    const secondResult = await loser;
    assert.equal(misses, 2, "Both requests observed the asset missing before the owner lock");
    assert.equal(locks, 2, "Both requests completed the owner-locked recheck");
    return [result, secondResult];
  } finally {
    released.forEach(value => value.resolve());
    finishWinner.resolve();
    await Promise.allSettled([winner, loser]);
    database.db.select = select;
    database.db.transaction = transaction;
    service.lockOwner = lockOwner;
    imageMasters.find = find;
  }
}

for (const endpoint of ["/upload-url", "/"] as const) {
  for (const sameBytes of [false, true]) {
    test(`image ${endpoint} rechecks a concurrent winner digest after the initial miss (${sameBytes ? "same" : "different"} bytes)`, async () => {
      owner = "alice";
      backend = "s3";
      const firstBytes = Buffer.from(`winner ${endpoint} ${sameBytes}`);
      const secondBytes = sameBytes ? firstBytes : Buffer.from(`loser ${endpoint}`);
      const firstMaster = await imageMasters.store({ userId: owner, access: "public", bytes: firstBytes, mimeType: "image/png" });
      const secondMaster = await imageMasters.store({ userId: owner, access: "public", bytes: secondBytes, mimeType: "image/png" });
      const requestId = crypto.randomUUID();
      const body = (key: string, bytes: Buffer) => ({ requestId, key, filename: "race.png", type: "image", contentType: "image/png", mimeType: "image/png", sizeBytes: bytes.length, sourceSha256: createHash("sha256").update(bytes).digest("hex") });
      const firstBody = body(firstMaster.key, firstBytes);
      const secondBody = body(secondMaster.key, secondBytes);
      try {
        const [winner, loser] = await raceAfterInitialMiss(() => post("/", firstBody), () => post(endpoint, secondBody));
        assert.equal(winner.status, 201, await winner.clone().text());
        assert.equal(loser.status, sameBytes ? endpoint === "/" ? 201 : 200 : 409, await loser.clone().text());
        if (sameBytes) {
          const winnerData = await data(winner);
          const loserData = await data(loser);
          assert.equal(endpoint === "/" ? loserData.id : loserData.asset?.id, winnerData.id);
        }
        assert.equal((await post(endpoint, firstBody)).status, endpoint === "/" ? 201 : 200, "matching retries still reconcile after the winner commits");
      } finally { backend = "local"; }
    });
  }
}
