import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { transform } from "sucrase";
import sharp from "sharp";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { createImageMasterService, isImageMasterKey } from "./image-master-service.js";
import { encodeImageMaster } from "./image-master-envelope.js";
import type * as ChatImages from "./chat-images.js";

test("chat image CAS preserves animated originals and logical names without repeated PUTs", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');`);
    await pg.exec(IMAGE_MASTERS_DDL);
    const objects = new Map<string, {buffer:Buffer;contentType:string}>(), writes: string[] = [];
    const write = async (key: string, bytes: Buffer, mime: string, options?: {contentEncoding?:"gzip"}) => {
      writes.push(key); objects.set(key, { buffer: options?.contentEncoding ? gunzipSync(bytes) : bytes, contentType: mime });
    };
    const masters = createImageMasterService(drizzle(pg) as unknown as DrizzleDB, { encode: encodeImageMaster, write });
    let saved: Array<{id:string;attachments:unknown[]}> = [];
    const file = new URL("./chat-images.ts", import.meta.url), require = createRequire(file);
    const loaded = { exports: {} as typeof ChatImages };
    const mocks: Record<string, unknown> = {
      "../db/index.js": { db: { select: () => ({ from: () => ({ where: async () => saved }) }) } },
      "./image-masters.js": { imageMasters: masters, isImageMasterKey },
      "./env.js": { PUBLIC_ORIGIN: "https://yumina.test" },
      "./s3.js": { putObject: write, getObjectBuffer: async (key:string) => { assert.ok(objects.has(key)); return objects.get(key); } },
    };
    new Function("require", "module", "exports", transform(readFileSync(file,"utf8"), { transforms:["typescript","imports"] }).code)
      ((id:string) => mocks[id] ?? require(id), loaded, loaded.exports);
    const subject = loaded.exports;
    const pixels = Buffer.alloc(8 * 16 * 4, 80); pixels.fill(200, 8 * 8 * 4);
    for (const [mime, bytes] of [
      ["image/png", await sharp({create:{width:8,height:6,channels:4,background:"#12345680"}}).withExif({IFD0:{ImageDescription:"keep original"}}).png().toBuffer()],
      ["image/gif", await sharp(pixels,{raw:{width:8,height:16,channels:4,pageHeight:8}}).gif({delay:[100,200],loop:3}).toBuffer()],
    ] as const) {
      const before = writes.length;
      const images = await subject.validateChatImages([{type:"image",mimeType:mime,name:"first",data:bytes.toString("base64")}]);
      const first = (await subject.storeChatImages("alice",images))[0]!;
      const second = (await subject.storeChatImages("alice",[{...images[0]!,name:"second"}]))[0]!;
      assert.equal(first.storageKey,second.storageKey); assert.equal(second.name,"second");
      assert.match(first.storageKey,/^users\/alice\/image-masters\/public\/[a-f0-9]{64}(?:\.(?:anim\.)?(?:png|jpg|webp|gif))?$/);
      assert.equal(writes.length-before,1,"same owner and exact file bytes require only one physical PUT");
      assert.deepEqual(objects.get(first.storageKey)!.buffer,bytes);
      assert.equal(objects.get(first.storageKey)!.contentType,mime);
      const foreign = (await subject.storeChatImages("bob",images))[0]!;
      assert.notEqual(foreign.storageKey,first.storageKey);
      saved = [{id:"message",attachments:[first]}];
      const restored = await subject.restoreChatImages("save",[{role:"user",content:"look",sourceMessageId:"message"}]);
      assert.deepEqual(restored[0]!.content,[{type:"text",text:"look"},{type:"image_url",image_url:{url:`data:${mime};base64,${bytes.toString("base64")}`}}]);
      const digest = first.storageKey.split("/").at(-1)!.split(".")[0]!;
      for (const key of [`users/alice/image-masters/public/${digest}.${mime === "image/png" ? "png" : "gif"}`,
        `users/alice/image-masters/public/${digest}`, `users/alice/chat-images/${digest}`]) {
        objects.set(key,{buffer:bytes,contentType:mime});
        saved = [{id:"message",attachments:[{...first,storageKey:key}]}];
        assert.deepEqual((await subject.restoreChatImages("save",[{role:"user",content:"look",sourceMessageId:"message"}]))[0]!.content,
          restored[0]!.content,"current suffixed and legacy hash-only references remain readable");
      }
      assert.deepEqual((await subject.normalizeImageCompletion([{role:"user",content:[{type:"image_url",image_url:{url:first.url}}]}]))[0]!.content,
        [{type:"image_url",image_url:{url:`data:${mime};base64,${bytes.toString("base64")}`}}]);
      const privateKey = (await masters.store({userId:"alice",access:"private",bytes,mimeType:mime})).key;
      saved = [{id:"message",attachments:[{...first,storageKey:privateKey}]}];
      await assert.rejects(subject.restoreChatImages("save",[{role:"user",content:"look",sourceMessageId:"message"}]),/Invalid stored image/);
    }
  } finally { await pg.close(); }
});
