import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { apngFixture } from "../test/image-master-fixtures.js";
import { normalizeImportedImage, downloadImportedImage, validateImageImportUrl, MAX_IMPORT_BYTES } from "./image-import.js";
import { createPinnedProviderFetch } from "./image-generation/host-transport.js";

test("image links reject active schemes, credentials, private literals and unusual ports", () => {
  for (const url of ["javascript:alert(1)", "data:image/png;base64,a", "file:///etc/passwd", "https://u:p@example.com/x", "http://localhost/x", "http://2130706433/x", "http://[::ffff:127.0.0.1]/x", "http://169.254.169.254/x", "https://example.com:22/x", "https://example.com/x#fragment", "https://example.com/\nimage"]) {
    assert.throws(() => validateImageImportUrl(url), url);
  }
  assert.equal(validateImageImportUrl(" https://example.com/image?token=abc "), "https://example.com/image?token=abc");
});

test("only real decodable raster images are accepted; original bytes and metadata are preserved", async () => {
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), Buffer.from('<html><script>alert(1)</script>'), Buffer.from([137,80,78,71,13,10,26,10])]) {
    await assert.rejects(normalizeImportedImage(bytes));
  }
  const png = await sharp({create:{width:4,height:3,channels:4,background:"transparent"}}).png().toBuffer();
  await assert.rejects(normalizeImportedImage(Buffer.concat([png,Buffer.from('<script>alert(1)</script>')])));
  const result = await normalizeImportedImage(png);
  assert.deepEqual(result.bytes, png);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.animated, false);

  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, 4); assert.equal(meta.height, 3); assert.equal(meta.hasAlpha, true);
  await assert.rejects(normalizeImportedImage(Buffer.alloc(MAX_IMPORT_BYTES + 1)));
});

test("GIFs keep their format; animated WebPs preserve both frames", async () => {
  const pixels = Buffer.from([255,0,0,255,0,0,255,255]);
  for (const format of ["gif", "webp"] as const) {
    const source = await sharp(pixels,{raw:{width:1,height:2,channels:4,pageHeight:1}})[format]({loop:3,delay:[100,200]}).toBuffer();
    const result = await normalizeImportedImage(source);
    assert.deepEqual(result.bytes, source, "frames, delays, loops and metadata remain byte-exact");
    assert.equal(result.animated, true);
    assert.equal(result.mimeType, `image/${format}`);
    const meta = await sharp(result.bytes,{animated:true}).metadata();
    assert.equal(meta.pages, 2);
    assert.deepEqual(meta.delay, [100,200]);
    assert.equal(meta.loop, 3);
  }
});

test("downloads reject HTML/SVG MIME, redirects, encoded and oversized responses", async () => {
  for (const response of [new Response('<html/>',{headers:{'content-type':'text/html'}}), new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}), new Response(null,{status:302,headers:{location:'http://localhost'}}), new Response('x',{headers:{'content-type':'image/png','content-length':String(MAX_IMPORT_BYTES+1)}}), new Response('x',{headers:{'content-type':'image/png','content-encoding':'gzip'}})]) {
    await assert.rejects(downloadImportedImage("https://example.com/x", AbortSignal.timeout(1000), async () => response));
  }
  const png = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
  let calls = 0;
  const result = await downloadImportedImage("https://example.com/picture", AbortSignal.timeout(1000), async (_input, init) => {
    calls++; assert.equal(new Headers(init?.headers).has("Cookie"),false); assert.equal(new Headers(init?.headers).has("Authorization"),false);
    return new Response(png,{headers:{'content-type':'image/png'}});
  });
  assert.equal(calls,1); assert.equal(result.mimeType,"image/png"); assert.deepEqual(result.bytes,png);
});

test("public names resolving to any private address never reach a socket", async () => {
  let requests = 0;
  const fetcher = createPinnedProviderFetch({allowPrivate:false},{ resolve:async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}],request:()=>{requests++; throw Error("must not connect");} });
  await assert.rejects(downloadImportedImage("https://example.com/image",AbortSignal.timeout(1000),fetcher));
  assert.equal(requests,0);
});


test("container tails are rejected while structured metadata and exact original files survive", async () => {
  for (const format of ["png", "jpeg", "gif", "webp"] as const) {
    const source = await sharp({create:{width:3,height:2,channels:4,background:"#12345678"}}).withMetadata({orientation:6})[format]().toBuffer();
    const result = await normalizeImportedImage(source);
    assert.deepEqual(result.bytes,source);
    await assert.rejects(normalizeImportedImage(Buffer.concat([source,Buffer.from("<script>tail</script>")])));
  }
});


test("APNG URL/paste imports retain the explicit unsupported policy without flattening a default frame", async () => {
  const source=apngFixture();
  await assert.rejects(normalizeImportedImage(source),/Animated PNG.*not supported/i);
  await assert.rejects(normalizeImportedImage(Buffer.concat([source,Buffer.from("trailing junk")])));
  const lateControl=Buffer.concat([source.subarray(0,33),source.subarray(53,-12),source.subarray(33,53),source.subarray(-12)]);
  await assert.rejects(normalizeImportedImage(lateControl),"late/malformed animation controls must not bypass the unsupported policy");
});
