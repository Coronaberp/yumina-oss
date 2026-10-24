import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

async function helpers() {
  assert.ok(existsSync(new URL("../../../sandbox/chat/chat-portrait.tsx", import.meta.url)), "Default-chat portrait warming needs an explicit bounded cache");
  return import("../../../sandbox/chat/chat-portrait");
}

test("default portrait cache is bounded and promotes recently used display URLs", async () => {
  const { createPortraitCache } = await helpers();
  const requested: string[] = [];
  const cache = createPortraitCache(24, () => ({ decoding: "", set src(value: string) { requested.push(value); } }) as unknown as HTMLImageElement);
  for (let i = 0; i < 1000; i++) cache.warm(`https://app.test/cdn/${i}?variant=portrait`);
  assert.equal(cache.size, 24); assert.equal(requested.length, 1000);
  const recent = "https://app.test/cdn/976?variant=portrait";
  cache.warm(recent); cache.warm("new");
  assert.equal(cache.has(recent), true); assert.equal(cache.has("https://app.test/cdn/977?variant=portrait"), false);
  assert.equal(cache.size, 24); assert.equal(requested.length, 1001);
});

test("portrait display variants preserve originals and unrelated URLs", async () => {
  const { chatPortraitUrl } = await helpers();
  const id = "11111111-2222-4333-8444-555555555555", origin = "https://app.test";
  const original = `${origin}/cdn/${id}?foo=bar#crop`;
  assert.equal(chatPortraitUrl(original, origin), `${origin}/cdn/${id}?foo=bar&variant=portrait#crop`);
  assert.equal(chatPortraitUrl(`/cdn/${id}`, origin), `/cdn/${id}?variant=portrait`);
  assert.equal(chatPortraitUrl(`${origin}/cdn/key/YWJj?variant=portrait`, origin), `${origin}/cdn/key/YWJj?variant=portrait`);
  for (const value of ["https://foreign.test/cdn/" + id, "https://foreign.test/face.png", "blob:face", "data:image/png;base64,face", "/vn-assets/face.png"]) assert.equal(chatPortraitUrl(value, origin), value);
  assert.equal(chatPortraitUrl(original, "*"), original, "Unknown parent must not rewrite arbitrary origins");
});
