import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { transform } from "sucrase";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import type { storeUploadedImage as StoreUploadedImage, imageMasters as ImageMasters } from "./image-masters.js";
const client=new PGlite(),db=drizzle(client) as unknown as DrizzleDB;
const size=33*1024*1024, chunkSize=64*1024;
const objects=new Map<string,{byte:number;size:number;prefix?:Buffer;contentType?:string}>();
let backend:"local"|"s3"="local";
let bufferedReads=0,copies=0,encodes=0,corruptCopy=false,readBytes=0;
const digest=(byte:number,prefix?:Buffer)=>{const h=createHash("sha256"),chunk=Buffer.alloc(chunkSize,byte);for(let offset=0;offset<size;offset+=chunkSize){const current=offset===0&&prefix?Buffer.concat([prefix,chunk.subarray(prefix.length)]):chunk;h.update(current);}return h.digest("hex");};
const file=new URL("./image-masters.ts",import.meta.url),require=createRequire(file),module={exports:{} as {storeUploadedImage:typeof StoreUploadedImage;imageMasters:typeof ImageMasters}};
const mocks:Record<string,unknown>={
 "../db/index.js":{db},
 "./image-master-envelope.js":{encodeImageMaster:async(bytes:Buffer)=>{encodes++;const hash=createHash("sha256").update(bytes).digest("hex");return {bytes,sourceSha256:hash,storedSha256:hash,originalSize:bytes.length,storedSize:bytes.length};}},
 "./s3.js":{storageKind:()=>backend,putObject:async(key:string,bytes:Buffer)=>{assert.ok(bytes.length<32*1024*1024,"large originals must not use buffered writes");objects.set(key,{size:bytes.length,byte:bytes[0]!});},
  getObjectBuffer:async()=>{bufferedReads++;throw Error("large original must not become a contiguous Buffer");},
  headObject:async(key:string)=>{const v=objects.get(key);assert.ok(v);return {contentType:v.contentType??"image/png",contentLength:v.size,etag:String(v.byte)};},
  getObject:async(key:string)=>{const v=objects.get(key);assert.ok(v);return {body:Readable.from((async function*(){const chunk=Buffer.alloc(chunkSize,v.byte);for(let offset=0;offset<v.size;offset+=chunkSize){readBytes+=chunk.length;yield offset===0&&v.prefix?Buffer.concat([v.prefix,chunk.subarray(v.prefix.length)]):chunk;}})()),contentType:"image/png",contentLength:v.size};},
  copyObject:async(source:string,destination:string,etag?:string,expected?:{contentType:string})=>{copies++;const v=objects.get(source);assert.ok(v);if(backend==="s3")assert.equal(etag,String(v.byte));else assert.equal(etag,undefined);objects.set(destination,{...v,contentType:expected?.contentType??v.contentType,byte:v.byte+(corruptCopy?1:0)});},
 },
};
new Function("require","module","exports",transform(readFileSync(file,"utf8"),{transforms:["typescript","imports"]}).code)((id:string)=>mocks[id]??require(id),module,module.exports);
before(async()=>{await client.exec(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('owner');`);await client.exec(IMAGE_MASTERS_DDL);});
after(async()=>{await client.close();});

test("large image originals use chunked verification and raw immutable copies without a new upload limit",async()=>{
 const key="worlds/owned/image/large.png";objects.set(key,{size,byte:7});const hash=digest(7);
 const master=await module.exports.storeUploadedImage({userId:"owner",key,mimeType:"image/png",sourceSha256:hash});
 assert.ok(!master.key.includes(hash),"streamed originals also require opaque storage locators");
 assert.equal(master.originalSize,size);assert.equal(master.sourceSha256,hash);assert.equal(master.contentEncoding,undefined);assert.equal(copies,1);assert.equal(encodes,0);assert.equal(bufferedReads,0);
 assert.equal(readBytes,size*2,"one source hash and one immutable-copy verification");
 objects.delete(key);assert.deepEqual(await module.exports.storeUploadedImage({userId:"owner",key,mimeType:"image/png",sourceSha256:hash}),master,"verified aliases reconcile after staging cleanup");
 console.log(JSON.stringify({proxy:"explicit decoded-buffer calls and fixture chunk bound, not measured RSS",inputBytes:size,largestFixtureChunkBytes:chunkSize,bufferedReads}));
});

test("a changed immutable copy cannot settle a master or staging alias",async()=>{
 const key="worlds/owned/image/changed.png",hash=digest(9);objects.set(key,{size,byte:9});corruptCopy=true;
 try{await assert.rejects(module.exports.storeUploadedImage({userId:"owner",key,mimeType:"image/png",sourceSha256:hash}),/changed/i);}
 finally{corruptCopy=false;}
 assert.equal(await module.exports.imageMasters.find("owner","public",hash),undefined);
 assert.equal(await module.exports.imageMasters.findUpload("owner","public",key),undefined);
});


test("public MIME guesses normalize only with the verified digest; private and active MIME checks remain strict",async()=>{
 const master=await module.exports.imageMasters.find("owner","public",digest(7));assert.ok(master);
 await assert.rejects(module.exports.storeUploadedImage({userId:"owner",key:master.key,mimeType:"image/jpeg"}),/does not match/i);
 assert.equal((await module.exports.storeUploadedImage({userId:"owner",key:master.key,mimeType:"image/jpeg",sourceSha256:master.sourceSha256})).mimeType,"image/png");
 await assert.rejects(module.exports.storeUploadedImage({userId:"owner",key:master.key,mimeType:"image/svg+xml",sourceSha256:master.sourceSha256}),/does not match/i);
 const privateMaster=await module.exports.imageMasters.store({userId:"owner",access:"private",bytes:Buffer.from("private original"),mimeType:"image/png"});
 await assert.rejects(module.exports.storeUploadedImage({userId:"owner",access:"private",key:privateMaster.key,mimeType:"image/jpeg",sourceSha256:privateMaster.sourceSha256}),/does not match/i);
});


test("large original copies retain bytes and use detected MIME for both local and S3 destinations",async()=>{
 const prefix=Buffer.from("89504e470d0a1a0a","hex");
 try{for(const [index,mode] of (["local","s3"] as const).entries()){
  backend=mode;const byte=20+index,key=`worlds/owned/image/renamed-${mode}.jpg`;objects.set(key,{size,byte,prefix,contentType:"image/jpeg"});
  const hash=digest(byte,prefix);const master=await module.exports.storeUploadedImage({userId:"owner",key,mimeType:"image/jpeg",sourceSha256:hash});
  assert.equal(master.mimeType,"image/png");assert.equal(master.sourceSha256,hash);assert.equal(objects.get(master.key)!.contentType,"image/png");
  assert.equal(objects.get(key)!.contentType,"image/jpeg","source metadata remains untouched");
 }}finally{backend="local";}
});
