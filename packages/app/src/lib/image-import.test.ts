import assert from "node:assert/strict";
import test from "node:test";
import { prepareImportedImage } from "./image-import";

test("unsafe links/files never trigger a request", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async()=>{requests++;throw Error("Unexpected request");};
  for (const source of ['javascript:alert(1)','data:image/png;base64,abc','https://u:p@example.com/x',new File(['<svg/>'],'x.svg',{type:'image/svg+xml'})]) {
    await assert.rejects(prepareImportedImage(source,AbortSignal.timeout(1000),'/api/import',fetcher));
  }
  assert.equal(requests,0);
});

test("every GIF and animated WebP skip crop; stills use crop and sanitized names", async () => {
  for (const [mime,animated,skipCrop] of [['image/gif','false',true],['image/gif','true',true],['image/webp','true',true],['image/webp','false',false]] as const) {
    const result = await prepareImportedImage('https://example.com/happy.png?secret=token',AbortSignal.timeout(1000),'/api/import',async(input,init)=>{
      assert.equal(input,'/api/import'); assert.equal(init?.credentials,'include');
      assert.equal(JSON.parse(init?.body as string).url,'https://example.com/happy.png?secret=token');
      return new Response('validated bytes',{headers:{'content-type':mime,'x-image-animated':animated}});
    });
    assert.equal(result.skipCrop,skipCrop); assert.equal(result.file.type,mime); assert.match(result.file.name,/^happy\.(gif|webp)$/);
  }
});

test("unexpected server content is never returned as a preview", async () => {
  await assert.rejects(prepareImportedImage('https://example.com/x',AbortSignal.timeout(1000),'/api/import',async()=>new Response('<script/>',{headers:{'content-type':'text/html'}})));
  for (const mime of ["constructor", "__proto__", "toString"]) {
    await assert.rejects(prepareImportedImage("https://example.test/image", new AbortController().signal, "/import", async () =>
      new Response("not a supported image", { headers: { "content-type": mime } })), /validated/);
  }
});

test("validated URL imports retain original raster bytes, MIME and an appropriate filename", async () => {
  for (const [mime, name, animated] of [
    ["image/png", "original.png", "false"], ["image/png", "animated.png", "true"],
    ["image/jpeg", "portrait.jpeg", "false"], ["image/gif", "clip.gif", "true"],
    ["image/webp", "scene.webp", "true"],
  ]) {
    const bytes = new Uint8Array([0, 1, 255, 2, 3, 4]);
    const result = await prepareImportedImage(`https://example.test/${name}?signed=private`, new AbortController().signal, "/import", async () =>
      new Response(bytes, { headers: { "content-type": mime!, "x-image-animated": animated! } }));
    assert.equal(result.file.name, name);
    assert.equal(result.file.type, mime);
    assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), bytes);
    assert.equal(result.skipCrop, mime === "image/gif" || animated === "true");
  }
  const fallback = await prepareImportedImage("https://example.test/download?id=123", new AbortController().signal, "/import", async () =>
    new Response("original JPEG", { headers: { "content-type": "image/jpeg" } }));
  assert.equal(fallback.file.name, "download.jpg");
});
