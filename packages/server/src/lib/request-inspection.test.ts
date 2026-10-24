import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestReceiptCache, createRequestCapture, snapshotRequest } from "./request-inspection.js";

test("wire snapshots allowlist parameters, redact secrets and omit image bytes/URLs", () => {
  const receipt = snapshotRequest("custom", {
    model: "wire-model", temperature: .4, headers: { Authorization: "SECRET" }, api_key: "SECRET",
    messages: [{ role: "system", content: "final system sk-abcdefghijk123456789012345\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz" },
      { role: "user", content: [{ type: "text", text: "user TEST_CREDENTIAL" }, { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE" } }] }],
    custom_secret: "HIDDEN", provider: { order: ["provider-a"], api_key: "SECRET" },
  }, ["TEST_CREDENTIAL"]);
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /SECRET|PRIVATE|TEST_CREDENTIAL|abcdefghijk|abcdefghijklmnopqrstuvwxyz|data:image/);
  assert.equal(receipt.model, "wire-model");
  assert.equal(receipt.parameters.temperature, .4);
  assert.match(text, /final system/);
  assert.match(text, /image omitted/);
  assert.ok(receipt.estimatedTextTokens > 0);
});

test("snapshots bound unicode and nested data before retention", () => {
  const result = snapshotRequest("openai", { model: "m", messages: [{ role: "system", content: "字".repeat(1_000_000) }] });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.equal(result.truncated, true);
});

test("a credential crossing the truncation boundary never leaves its prefix", () => {
  const credential = "sensitive-credential-with-a-long-tail";
  const snapshot = snapshotRequest("custom", { model: "m", messages: [{ content: "x".repeat(3900) + credential }] }, [credential]);
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive-credential/);
});

test("cache enforces owner/session/world binding, expiry, count and byte bounds", () => {
  let now = 0;
  const cache = new RequestReceiptCache({ now: () => now, ttlMs: 100, maxEntries: 2, maxBytes: 3000 });
  const capture = createRequestCapture();
  capture.onRequest({ provider: "openai", body: { model: "actual", messages: [{ role: "user", content: "secret story" }] } });
  const scope = { userId: "creator", sessionId: "own", worldId: "card", messageId: "m", swipeIndex: 0 };
  cache.put(scope, capture.finish("send", { promptTokens: 15, completionTokens: 5, totalTokens: 20 }));
  assert.equal(cache.get(scope)?.[0]?.usage?.promptTokens, 15);
  for (const changed of [{ userId: "player" }, { sessionId: "other" }, { worldId: "other" }, { swipeIndex: 1 }]) {
    assert.equal(cache.get({ ...scope, ...changed }), undefined);
  }
  cache.put({ ...scope, messageId: "m2" }, capture.finish("regenerate"));
  cache.put({ ...scope, messageId: "m3" }, capture.finish("continue"));
  assert.equal(cache.get(scope), undefined);
  now = 101;
  assert.equal(cache.get({ ...scope, messageId: "m3" }), undefined);
  assert.equal(cache.stats().bytes, 0);
});

test("capture keeps actual retries separately and missing usage unknown", () => {
  const capture = createRequestCapture();
  for (let i = 0; i < 9; i++) capture.onRequest({ provider: "custom", body: { model: `attempt-${i}`, messages: [] } });
  const receipt = capture.finish("regenerate");
  assert.equal(receipt.attempts.length, 4);
  assert.equal(receipt.omittedAttempts, 5);
  assert.equal(receipt.attempts.at(-1)?.model, "attempt-8");
  assert.equal(receipt.usage, undefined);
});

test("continuations do not extend the original receipt's retention", () => {
  let now = 0;
  const cache = new RequestReceiptCache({ now: () => now, ttlMs: 100 });
  const capture = createRequestCapture();
  capture.onRequest({ provider: "custom", body: { model: "m", messages: [] } });
  const scope = { userId: "u", worldId: "w", sessionId: "s", messageId: "m", swipeIndex: 0 };
  cache.put(scope, capture.finish("send"));
  now = 90; cache.put(scope, capture.finish("continue"));
  now = 101;
  assert.deepEqual(cache.get(scope)?.map(receipt => receipt.kind), ["continue"]);
});

test("byte cap evicts older swipes and refuses a receipt larger than the whole cache", () => {
  const cache = new RequestReceiptCache({ maxBytes: 1000 });
  const capture = createRequestCapture();
  capture.onRequest({ provider: "custom", body: { model: "m", messages: [{ content: "x".repeat(2000) }] } });
  const scope = { userId: "u", worldId: "w", sessionId: "s", messageId: "m", swipeIndex: 0 };
  cache.put(scope, capture.finish("send"));
  assert.equal(cache.get(scope), undefined);
  assert.equal(cache.stats().bytes, 0);
});
