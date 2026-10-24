import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicCdnKey } from "./cdn-key-policy.js";

test("CDN lookup rejects missing or private database keys", async () => {
  for (const key of [null, "private-session-media/player/objects/image/main.webp"]) {
    assert.equal(await resolvePublicCdnKey(async () => key), null);
  }
});

test("CDN lookup resolves the current logical binding on every request", async () => {
  let current: string | null = "users/player/image-masters/public/retained.png";
  let lookups = 0;
  const lookup = async () => { lookups++; return current; };
  assert.equal(await resolvePublicCdnKey(lookup), current);
  current = null;
  assert.equal(await resolvePublicCdnKey(lookup), null);
  assert.equal(lookups, 2);
});

test("CDN lookup rejects traversal and backslash keys returned by the database", async () => {
  for (const value of ["users/../private-session-media/image", "users/player\\image"]) {
    assert.equal(await resolvePublicCdnKey(async () => value), null);
  }
});
