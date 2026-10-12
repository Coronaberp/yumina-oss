import assert from "node:assert/strict";
import test from "node:test";
import { cdnOriginForRequest, resolveImageCdn } from "./cdn-url.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { runWithRequestCache } from "./request-cache.js";

test("media URLs follow the current public or LAN request instead of the configured LAN origin", async () => {
  const key = "worlds/library/thumbnail/cover.anim.png";
  const path = `/cdn/key/${Buffer.from(key).toString("base64url")}`;
  const origins = ["https://vn.storyhaven.dev", "http://192.168.88.9:3000", "http://127.0.0.1:3000"];
  const results = await Promise.all(origins.map(origin => runWithRequestCache(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return resolveImageCdn(key);
  }, origin)));
  assert.deepEqual(results, origins.map(origin => `${origin}${path}`));
  assert.equal(resolveImageCdn(key), `${PUBLIC_ORIGIN}${path}`, "background work retains its configured origin");
});

test("proxy TLS is recovered only for the configured matching host", () => {
  const configured = ["http://192.168.88.9:3000", "https://vn.storyhaven.dev"];
  assert.equal(cdnOriginForRequest("http://vn.storyhaven.dev/api/worlds", configured), "https://vn.storyhaven.dev");
  assert.equal(cdnOriginForRequest("http://192.168.88.9:3000/api/worlds", configured), "http://192.168.88.9:3000");
  assert.equal(cdnOriginForRequest("http://127.0.0.1:3000/api/worlds", configured), "http://127.0.0.1:3000");
  assert.equal(cdnOriginForRequest("https://secure.example/api/worlds", configured), "https://secure.example");
});

test("request origin does not rewrite foreign image URLs or asset references", async () => {
  await runWithRequestCache(async () => {
    assert.equal(resolveImageCdn("https://images.example/cover.png"), "https://images.example/cover.png");
    assert.equal(resolveImageCdn("/cdn/key/already-resolved"), "/cdn/key/already-resolved");
    assert.equal(resolveImageCdn("@asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "https://vn.storyhaven.dev/cdn/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(resolveImageCdn(null), null);
  }, "https://vn.storyhaven.dev");
});

test("saved relative CDN links remain idempotent instead of being encoded as storage keys", () => {
  for (const url of ["/cdn/12345678-1234-4234-9234-123456789abc", "/cdn/key/d29ybGRzL2ltYWdlLndlYnA"]) {
    assert.equal(resolveImageCdn(url), url);
    assert.equal(resolveImageCdn(resolveImageCdn(url)), url);
  }
});

test("external URLs and missing images keep their existing behavior", () => {
  assert.equal(resolveImageCdn("https://images.example/test.webp"), "https://images.example/test.webp");
  assert.equal(resolveImageCdn(null), null);
  assert.equal(resolveImageCdn("data:image/png;base64,test"), null);
});
