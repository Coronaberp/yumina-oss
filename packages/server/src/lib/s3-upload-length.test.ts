import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "./env.js";
import { generateUploadUrl, storageKind } from "./s3.js";

test("S3 upload signing includes exact length and expiry without sending a request", async () => {
  const previous = { AWS_S3_BUCKET_NAME: env.AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY };
  Object.assign(env, { AWS_S3_BUCKET_NAME: "isolated-signing-test", AWS_ACCESS_KEY_ID: "test-access-key", AWS_SECRET_ACCESS_KEY: "test-signing-secret" });
  try {
    assert.equal(storageKind(), "s3");
    const signed = new URL(await generateUploadUrl("worlds/length/a.txt", "text/plain", { contentLength: 3, expiresIn: 600 }));
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "600");
    assert.ok(signed.searchParams.get("X-Amz-SignedHeaders")?.split(";").includes("content-length"));
    const differentLength = new URL(await generateUploadUrl("worlds/length/a.txt", "text/plain", { contentLength: 4, expiresIn: 600 }));
    assert.notEqual(signed.searchParams.get("X-Amz-Signature"), differentLength.searchParams.get("X-Amz-Signature"));
    const legacy = new URL(await generateUploadUrl("worlds/length/a.txt", "text/plain"));
    assert.equal(legacy.searchParams.get("X-Amz-Expires"), "3600");
    assert.equal(legacy.searchParams.get("X-Amz-SignedHeaders")?.split(";").includes("content-length"), false);
  } finally {
    Object.assign(env, previous);
  }
});
