import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestReceiptCache, createOwnedRequestCapture, createRequestCapture, snapshotRequest } from "./request-inspection.js";

test("capture is enabled only for the recognized card owner playing their own session", () => {
  assert.ok(createOwnedRequestCapture("owner", "owner", "owner"));
  assert.equal(createOwnedRequestCapture("player", "player", "owner"), undefined);
  assert.equal(createOwnedRequestCapture("admin", "admin", "owner"), undefined);
  assert.equal(createOwnedRequestCapture("owner", "player", "owner"), undefined);
  assert.equal(createOwnedRequestCapture("", "", ""), undefined);
});

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

test("prompt-embedded JSON credentials and authentication headers are redacted", () => {
  const result = snapshotRequest("custom", { model: "m", messages: [{ content: '\\n{"password":"PASSWORD_VALUE","api_key":"API_VALUE"}\\nAuthorization: Basic BASIC_VALUE\\nCookie: sid=COOKIE_VALUE\\n' }] });
  assert.doesNotMatch(JSON.stringify(result), /PASSWORD_VALUE|API_VALUE|BASIC_VALUE|COOKIE_VALUE/);
});

test("quoted credentials containing whitespace, escapes or newlines are entirely redacted", () => {
  const content = JSON.stringify({ password: 'correct horse battery staple', secret: 'words "quoted" and trailing', api_key: "line one\nline two" });
  const result = snapshotRequest("custom", { model: "m", messages: [{ content }] });
  assert.doesNotMatch(JSON.stringify(result), /correct|horse|battery|staple|quoted|trailing|line one|line two/);
});

test("unquoted multiline credential assignments redact the complete secret line", () => {
  const result = snapshotRequest("custom", { model: "m", messages: [{ content: "password = correct horse battery staple\nPublic prompt" }] });
  assert.doesNotMatch(JSON.stringify(result), /correct|horse|battery|staple/);
  assert.match(JSON.stringify(result), /Public prompt/);
});

test("credential-bearing keys are redacted and credential fields cannot bypass traversal limits", () => {
  let reads = 0;
  const provider: Record<string, unknown> = {};
  for (let index = 0; index < 10000; index++) Object.defineProperty(provider, `password=KNOWN_CREDENTIAL_${index}`, { enumerable: true, get() { reads++; return "private"; } });
  const result = snapshotRequest("custom", { model: "m", provider }, ["KNOWN_CREDENTIAL"]);
  assert.doesNotMatch(JSON.stringify(result), /KNOWN_CREDENTIAL/);
  assert.ok(reads < 2048, "sanitization cannot eagerly materialize all credential values");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
});

test("cache enforces owner/session/world binding, expiry, count and byte bounds", () => {
  let now = 0;
  const cache = new RequestReceiptCache({ now: () => now, ttlMs: 100, maxEntries: 2, maxBytes: 3000 });
  const capture = createRequestCapture();
  capture.onRequest({ provider: "openai", body: { model: "actual", messages: [{ role: "user", content: "secret story" }] } });
  const scope = { userId: "creator", sessionId: "own", worldId: "card", messageId: "m", swipeIndex: 0 };
  capture.onUsage({ promptTokens: 15, completionTokens: 5, totalTokens: 20 });
  cache.put(scope, capture.finish("send"));
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

test("only raw provider counters are actual; retries clear earlier usage and absent fields stay unknown", () => {
  const capture = createRequestCapture();
  capture.onRequest({ provider: "custom", body: { model: "m", messages: [] } });
  capture.onUsage({ promptTokens: 10, completionTokens: 3 });
  capture.onRequest({ provider: "custom", body: { model: "m", messages: [] } });
  assert.equal(capture.finish("send").usage, undefined);
  capture.onUsage({ promptTokens: 12, completionTokens: undefined, totalTokens: Number.NaN });
  assert.deepEqual(capture.finish("send").usage, { promptTokens: 12 });
});

test("a local-bridge job is not represented as the final request to the model", () => {
  const capture = createRequestCapture();
  capture.onRequest({ provider: "local-bridge", body: { model: "m", messages: [{ role: "user", content: "bridge job" }] } });
  assert.equal(capture.finish("send").attempts.length, 0);
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
