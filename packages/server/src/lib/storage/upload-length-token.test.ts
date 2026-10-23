import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalDiskStorage, signUploadToken, verifyUploadToken } from "./local-disk.js";

const secret = "upload-length-tests-only";
const claims = { key: "worlds/length/a.txt", contentType: "text/plain", exp: 5000, contentLength: 3 };

test("upload token authenticates its exact length and expires at the signed deadline", () => {
  const token = signUploadToken(claims, secret);
  assert.deepEqual(verifyUploadToken(token, secret, 4999), { key: claims.key, contentType: claims.contentType, contentLength: 3 });
  assert.equal(verifyUploadToken(token, secret, 5000), null);
  const [, signature] = token.split(".");
  const tampered = Buffer.from(JSON.stringify({ ...claims, contentLength: 300 })).toString("base64url");
  assert.equal(verifyUploadToken(`${tampered}.${signature}`, secret, 1000), null);
});

test("local upload preparation refuses invalid lengths and expiry options", async () => {
  const storage = new LocalDiskStorage({ root: "/unused-by-signing", publicOrigin: "", secret });
  for (const contentLength of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(storage.generateUploadUrl(claims.key, claims.contentType, { contentLength, expiresIn: 600 }));
  }
  for (const expiresIn of [0, -1, 1.5, Infinity]) {
    await assert.rejects(storage.generateUploadUrl(claims.key, claims.contentType, { contentLength: 3, expiresIn }));
  }
});

test("invalid signed length claims are rejected while zero-length and legacy claims remain valid", () => {
  for (const contentLength of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    const token = signUploadToken({ ...claims, contentLength } as never, secret);
    assert.equal(verifyUploadToken(token, secret, 1000), null, String(contentLength));
  }
  assert.equal(verifyUploadToken(signUploadToken({ ...claims, contentLength: 0 }, secret), secret, 1000)?.contentLength, 0);
  const { contentLength: _, ...legacy } = claims;
  assert.deepEqual(verifyUploadToken(signUploadToken(legacy, secret), secret, 1000), { key: claims.key, contentType: claims.contentType });
});
