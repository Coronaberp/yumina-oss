import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import sharp from "sharp";
import { apngFixture } from "../test/image-master-fixtures.js";
import type { AppEnv } from "../lib/types.js";
import { createImageImportRoutes } from "./image-import.js";
import { MAX_IMPORT_BYTES, readImportBody } from "../lib/image-import.js";

function app(owner: string | null, rateLimit = async () => null as {error:string;retryAfter:number} | null) {
  const root = new Hono<AppEnv>();
  root.use("/*", async (c, next) => { if (owner) c.set("user", {id:owner} as AppEnv["Variables"]["user"]); await next(); });
  root.route("/", createImageImportRoutes({ rateLimit }));
  return root;
}
const post = (body: NonNullable<RequestInit["body"]>, type = "application/json") => ({method:"POST",headers:{"Content-Type":type},body});

test("source endpoint requires auth, JSON/raster MIME and bounds URL requests", async () => {
  assert.equal((await app(null).request("/",post('{}'))).status,401);
  const root = app("alice");
  for (const body of ['{', '{}', '{"url":"javascript:alert(1)"}', JSON.stringify({url:"http://localhost/x"}), ' '.repeat(8193)]) {
    assert.equal((await root.request("/",post(body))).status,400);
  }
  assert.equal((await root.request("/",post('<svg/>','image/svg+xml'))).status,415);
  assert.equal((await root.request("/",{...post('x','image/png'),headers:{'content-type':'image/png','content-length':String(MAX_IMPORT_BYTES+1)}})).status,413);
  const limited = await app("alice",async()=>({error:"Slow down",retryAfter:30})).request("/",post('{}'));
  assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'30');
});

test("valid images return raster bytes with safe headers and failed imports release slots", async () => {
  const root = app("alice");
  await root.request("/",post('not an image','image/png'));
  const png = await sharp({create:{width:2,height:2,channels:4,background:"transparent"}}).png().toBuffer();
  const response = await root.request("/",post(png,'image/png'));
  assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/png');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-image-animated'),'false');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
});

test("stalled/oversized streams cancel, and one user cannot occupy multiple import slots", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const controller = new AbortController();
  const read = readImportBody(stream,100,controller.signal);
  controller.abort();
  await assert.rejects(read); assert.equal(cancelled,true);
  await assert.rejects(readImportBody(new ReadableStream({start(c){c.enqueue(new Uint8Array(101));}}),100,AbortSignal.timeout(1000)));

  let release!: () => void;
  const waiting = new Promise<void>(resolve=>{release=resolve;});
  const root = new Hono<AppEnv>();
  root.use("/*",async(c,next)=>{c.set('user',{id:'alice'} as AppEnv['Variables']['user']);await next();});
  root.route('/',createImageImportRoutes({rateLimit:async()=>null,fetcher:async()=>{await waiting;return new Response('',{status:500});}}));
  const first = root.request('/',post('{"url":"https://example.com/image"}'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await root.request('/',post('{}'))).status,429);
  release(); assert.equal((await first).status,400);
  assert.equal((await root.request('/',post('{}'))).status,400);
});


test("APNG URL/paste import explains the existing unsupported policy without returning a flattened image",async()=>{
 const response=await app("alice").request("/",post(apngFixture(),"image/png"));assert.equal(response.status,400);
 const body=await response.json() as {error:string};assert.match(body.error,/Animated PNG imports are not supported/);
});
