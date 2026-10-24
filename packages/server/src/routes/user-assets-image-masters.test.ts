import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Hono, Context } from "hono";
import type { AppEnv } from "../lib/types.js";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { createImageMasterService, ImageMasterError, isImageMasterKey, validSourceSha256 } from "../lib/image-master-service.js";
const client = new PGlite(); const database = drizzle(client) as unknown as DrizzleDB;
let owner = "alice", signed = 0, writes = 0;
const objects = new Map<string, { buffer: Buffer; contentType: string; contentLength: number; etag: string }>();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const imageMasters = createImageMasterService(database, {
  encode: async bytes => ({ bytes, sourceSha256: digest(bytes), storedSha256: digest(bytes), originalSize: bytes.length, storedSize: bytes.length }),
  write: async (key, buffer, contentType) => { writes++; objects.set(key, { buffer, contentType, contentLength: buffer.length, etag: digest(buffer) }); },
});
const file = new URL("./user-assets.ts", import.meta.url); const require = createRequire(file);
const module = {exports:{} as {userAssetRoutes:Hono<AppEnv>}};
const mocks: Record<string, unknown> = {
  "../db/index.js": {db:database},
  "../middleware/auth.js": {authMiddleware:async(c:Context<AppEnv>,next:()=>Promise<void>)=>{c.set("user",{id:owner} as AppEnv["Variables"]["user"]);await next();}},
  "../lib/env.js": {env:{BETTER_AUTH_URL:"https://fixture.test"}},
  "../lib/session-media.js": {sessionMedia:{isReady:async()=>false,lockOwner:async()=>{}}},
  "../lib/generation/asset-receipts.js": {detachGenerationAsset:async()=>{}},
  "../lib/s3.js": {storageKind:()=>"local",isS3Configured:()=>true,
    generateUploadUrl:async()=>{signed++;return "https://storage.test/upload";},
    headObject:async(key:string)=>{const o=objects.get(key);assert.ok(o);return o;},
    deleteObject:async(key:string)=>{assert.ok(!isImageMasterKey(key),"shared master must not be deleted with a logical asset");objects.delete(key);}},
  "../lib/image-masters.js": {imageMasters,ImageMasterError,isImageMasterKey,validSourceSha256,
    storeUploadedImage:async(input:{userId:string;key:string;mimeType:string;sourceSha256?:string},tx:Pick<DrizzleDB,"execute">)=>{
      if(isImageMasterKey(input.key)){const m=await imageMasters.findByKey(input.userId,"public",input.key,tx);if(!m||input.sourceSha256&&m.sourceSha256!==input.sourceSha256)throw new ImageMasterError("Image master not found",404);return m;}
      return imageMasters.store({...input,access:"public",bytes:objects.get(input.key)!.buffer},tx);
    }},
};
new Function("require","module","exports",transform(readFileSync(file,"utf8"),{transforms:["typescript","imports"]}).code)((id:string)=>mocks[id]??require(id),module,module.exports);
const post=(path:string,body:object)=>module.exports.userAssetRoutes.request(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
const data=async(r:Response)=>(await r.json() as {data:Record<string,any>}).data;
before(async()=>{await client.exec(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('alice'),('bob');
CREATE TABLE asset_folders(id text PRIMARY KEY,user_id text,name text,parent_folder_id text,created_at timestamp DEFAULT now());
CREATE TABLE user_assets(id text PRIMARY KEY,user_id text,type text,filename text,url text,size_bytes integer,mime_type text,folder_id text,source_asset_id text,is_public boolean DEFAULT false,created_at timestamp DEFAULT now());`);await client.exec(IMAGE_MASTERS_DDL);});
after(async()=>{await client.close();});

test("prepare reuses an owned exact-byte master without another PUT; registration preserves independent names",async()=>{
  const bytes=Buffer.from("original PNG bytes and original metadata");const sourceSha256=digest(bytes);
  const one={requestId:crypto.randomUUID(),filename:"one.png",type:"image",contentType:"image/png",sizeBytes:bytes.length,sourceSha256};
  const p=await data(await post("/upload-url",one));objects.set(p.key,{buffer:bytes,contentType:"image/png",contentLength:bytes.length,etag:sourceSha256});
  const firstResponse=await post("/",{...one,key:p.key,mimeType:"image/png"});assert.equal(firstResponse.status,201,await firstResponse.clone().text());const first=await data(firstResponse);
  assert.equal(first.filename,"one.png");assert.equal(first.mimeType,"image/png");assert.deepEqual(objects.get(first.key)!.buffer,bytes);
  const before=signed;const two={...one,filename:"different-name.jpeg",contentType:"image/jpeg",requestId:crypto.randomUUID()};const reused=await data(await post("/upload-url",two));
  assert.equal(reused.reused,true);assert.equal(reused.key,first.key);assert.equal(reused.uploadUrl,undefined);assert.equal(signed,before);
  const second=await data(await post("/",{...two,key:reused.key,mimeType:"image/jpeg"}));assert.notEqual(second.id,first.id);assert.equal(second.filename,two.filename);assert.equal(second.key,first.key);
  const replay=await data(await post("/",{...two,key:reused.key,mimeType:"image/jpeg"}));assert.equal(replay.id,second.id);
  assert.equal((await post("/upload-url",{...two,sourceSha256:"c".repeat(64)})).status,409,"a replay ID cannot silently select a different image");
  assert.equal((await post("/",{...two,key:reused.key,mimeType:"image/jpeg",sourceSha256:"c".repeat(64)})).status,409);
  const removed=await module.exports.userAssetRoutes.request(`/${first.id}`,{method:"DELETE"});assert.equal(removed.status,200);assert.deepEqual(objects.get(second.key)!.buffer,bytes);
});

test("preflight and canonical-key registration do not grant another owner access",async()=>{
  const bytes=Buffer.from("private to Alice registry");const master=await imageMasters.store({userId:"alice",access:"public",bytes,mimeType:"image/png"});owner="bob";
  try{const p=await data(await post("/upload-url",{filename:"secret.png",type:"image",sourceSha256:digest(bytes)}));assert.equal(p.reused,undefined);assert.ok(p.uploadUrl);
  const response=await post("/",{filename:"secret.png",type:"image",key:master.key,mimeType:"image/png",sourceSha256:digest(bytes),sizeBytes:bytes.length});assert.ok([400,404].includes(response.status));}
  finally{owner="alice";}
});

test("uploaded payload digest mismatch is rejected before registration",async()=>{
 const req={requestId:crypto.randomUUID(),filename:"spoof.png",type:"image",contentType:"image/png",sourceSha256:"b".repeat(64)};const p=await data(await post("/upload-url",req));const bytes=Buffer.from("different bytes");objects.set(p.key,{buffer:bytes,contentType:"image/png",contentLength:bytes.length,etag:digest(bytes)});
 const before=writes;const r=await post("/",{...req,key:p.key,mimeType:"image/png",sizeBytes:bytes.length});assert.equal(r.status,409,await r.clone().text());assert.equal(writes,before);
});
