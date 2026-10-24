import "../../test/database-fixture.js";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../db/index.js";
import { user, userAssets, danbooruAssetSources } from "../../db/schema.js";
import { getObjectBuffer } from "../s3.js";
import { imageMasters } from "../image-masters.js";
import { normalizeDanbooruPost } from "./danbooru.js";
import { danbooruAssetId } from "./danbooru-import.js";
import { storeDanbooruAsset } from "./danbooru-storage.js";

after(async () => { if ("close" in db.$client) await db.$client.close(); });

const post=(id:number)=>normalizeDanbooruPost({id,file_url:`https://cdn.donmai.us/original/${id}.png`,file_ext:"png",rating:"g",image_width:2,image_height:3,tag_string_artist:`artist_${id}`})!;

test("different Danbooru posts share exact original bytes while retaining independent attribution, filenames and replay",async()=>{
 const owner=crypto.randomUUID();await db.insert(user).values({id:owner,name:"Danbooru fixture",email:`${owner}@test.invalid`});
 const bytes=await sharp({create:{width:2,height:3,channels:4,background:"#12345678"}}).withExif({IFD0:{ImageDescription:"Preserve original creator metadata"}}).png().toBuffer();
 const first=await storeDanbooruAsset(owner,bytes,post(101),"first.png"),second=await storeDanbooruAsset(owner,bytes,post(102),"second.png");
 assert.notEqual(first.id,second.id);assert.equal(first.filename,"first.png");assert.equal(second.filename,"second.png");
 const rows=await db.select().from(userAssets).where(and(eq(userAssets.userId,owner),inArray(userAssets.id,[first.id,second.id])));assert.equal(rows.length,2);
 assert.equal(rows[0]!.url,rows[1]!.url);assert.match(rows[0]!.url,/\/image-masters\/public\/[a-f0-9]{64}\.png$/);
 assert.deepEqual((await getObjectBuffer(rows[0]!.url)).buffer,bytes);
 const sources=await db.select().from(danbooruAssetSources).where(eq(danbooruAssetSources.userId,owner));
 assert.deepEqual(new Set(sources.map(s=>s.postId)),new Set([101,102]));
 assert.ok(sources.every(s=>(s.metadata as {attribution:string}).attribution.includes(`/posts/${s.postId}`)));
 assert.equal((await storeDanbooruAsset(owner,bytes,post(101),"renamed.png")).id,first.id);
 assert.equal((await db.execute(sql`SELECT count(*)::int AS n FROM image_masters WHERE user_id=${owner}`)).rows[0]!.n,1);
});

test("a failed Danbooru logical registration cannot delete a shared original",async()=>{
 const owner=crypto.randomUUID();await db.insert(user).values({id:owner,name:"Rollback fixture",email:`${owner}@test.invalid`});
 const bytes=await sharp({create:{width:2,height:3,channels:4,background:"#abcdef80"}}).withMetadata().png().toBuffer();
 const saved=await storeDanbooruAsset(owner,bytes,post(201));
 const [row]=await db.select().from(userAssets).where(eq(userAssets.id,saved.id));
 const conflict=danbooruAssetId(owner,202);await db.insert(userAssets).values({id:conflict,userId:owner,type:"txt",filename:"unrelated.txt",url:"users/fixture/unrelated.txt",mimeType:"text/plain",sizeBytes:1});
 await assert.rejects(storeDanbooruAsset(owner,bytes,post(202)),{code:"IMPORT_FAILED"});
 assert.deepEqual((await getObjectBuffer(row!.url)).buffer,bytes);
 assert.equal((await db.execute(sql`SELECT count(*)::int AS n FROM image_masters WHERE user_id=${owner}`)).rows[0]!.n,1);
 const [unchanged]=await db.select().from(userAssets).where(eq(userAssets.id,conflict));assert.equal(unchanged!.filename,"unrelated.txt");
 const originalSha=createHash("sha256").update(bytes).digest("hex");
 const master=await imageMasters.find(owner,"public",originalSha);assert.equal(master!.key,row!.url);assert.ok(!row!.url.includes(originalSha));
});
