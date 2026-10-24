import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, mock, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { putObject, getObjectBuffer, getObjectBufferLimited, headObject, getObject, copyObject, storageKind } from "./s3.js";
import { LocalDiskStorage } from "./storage/local-disk.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const inspectCommand = (value: unknown) => value as { constructor: { name: string }; input: Record<string, unknown> };
const originalEnvironment = { AWS_S3_BUCKET_NAME: env.AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY };
afterEach(() => { mock.restoreAll(); Object.assign(env, originalEnvironment); });

test("S3 writes, heads, streams, decodes and conditionally copies image envelopes", async () => {
  Object.assign(env, { AWS_S3_BUCKET_NAME: "isolated-test", AWS_ACCESS_KEY_ID: "isolated", AWS_SECRET_ACCESS_KEY: "isolated" });
  const original = Buffer.from("synthetic original image metadata ".repeat(100)); const bytes = gzipSync(original);
  const options = { contentEncoding: "gzip", decodedLength: original.length, sourceSha256: sha(original), storedSha256: sha(bytes) };
  const metadata = { "decoded-size": String(original.length), "source-sha256": sha(original), "stored-sha256": sha(bytes) };
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  mock.method(S3Client.prototype, "send", async (value: unknown) => {
    const command = inspectCommand(value);
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "PutObjectCommand") return {};
    if (command.constructor.name === "CopyObjectCommand") return {};
    return { ContentType: "image/png", ContentLength: bytes.length, ContentEncoding: "gzip", Metadata: metadata, ETag: '"stored-etag"', Body: Readable.from([bytes]) };
  });
  await putObject("users/test/source.png", bytes, "image/png", options);
  assert.deepEqual(calls[0]!.input, { Bucket: "isolated-test", Key: "users/test/source.png", Body: bytes, ContentType: "image/png", ContentEncoding: "gzip", Metadata: metadata });
  const head = await headObject("users/test/source.png");
  for (const [key, value] of Object.entries(options)) assert.equal(head[key as keyof typeof head], value);
  const object = await getObject("users/test/source.png"); assert.equal(object.sourceSha256, options.sourceSha256);
  (object.body as Readable).destroy();
  assert.deepEqual((await getObjectBuffer("users/test/source.png")).buffer, original);
  assert.deepEqual(await getObjectBufferLimited("users/test/source.png", original.length), original);
  await assert.rejects(getObjectBufferLimited("users/test/source.png", original.length - 1), /limit|SIZE/i);
  await copyObject("users/test/source.png", "users/test/copy.png", "stored-etag", { contentType: "image/png", contentLength: bytes.length });
  const copy = calls.find(call => call.name === "CopyObjectCommand")!.input;
  assert.equal(copy.ContentEncoding, "gzip"); assert.deepEqual(copy.Metadata, metadata);
});

test("local facade forwards an explicit copy MIME and still refuses conditional local copies", async () => {
  Object.assign(env, { AWS_S3_BUCKET_NAME: "", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" });
  assert.equal(storageKind(), "local");
  const calls: unknown[][] = [];
  mock.method(LocalDiskStorage.prototype, "copyObject", async (...args: Parameters<LocalDiskStorage["copyObject"]>) => { calls.push(args); });
  await copyObject("users/test/source.jpg", "users/test/destination.png", undefined, { contentType: "image/png", contentLength: 123 });
  assert.deepEqual(calls, [["users/test/source.jpg", "users/test/destination.png", { contentType: "image/png" }]]);
  await assert.rejects(copyObject("users/test/source.jpg", "users/test/no-copy.png", "etag", { contentType: "image/png", contentLength: 123 }), /Conditional copy requires S3/);
  assert.equal(calls.length, 1);
});

test("S3 copy MIME overrides retain encoding and source metadata with or without a conditional ETag", async () => {
  Object.assign(env, { AWS_S3_BUCKET_NAME: "isolated-test", AWS_ACCESS_KEY_ID: "isolated", AWS_SECRET_ACCESS_KEY: "isolated" });
  const metadata = { "decoded-size": "1000", "source-sha256": "a".repeat(64), "stored-sha256": "b".repeat(64), "retained-source-note": "unchanged" };
  const calls: Array<Record<string, unknown>> = [];
  mock.method(S3Client.prototype, "send", async (value: unknown) => {
    const command = inspectCommand(value);
    if (command.constructor.name === "CopyObjectCommand") { calls.push(command.input); return {}; }
    return { ContentType: command.input.Key === "users/test/source.jpg" ? "image/jpeg" : "image/png", ContentLength: 100, ContentEncoding: "gzip", Metadata: metadata, ETag: '"source-etag"' };
  });
  await copyObject("users/test/source.jpg", "users/test/conditional.png", "source-etag", { contentType: "image/png", contentLength: 100 });
  await copyObject("users/test/source.jpg", "users/test/unconditional.png", undefined, { contentType: "image/png", contentLength: 100 });
  assert.equal(calls.length, 2);
  for (const copy of calls) {
    assert.equal(copy.ContentType, "image/png"); assert.equal(copy.ContentEncoding, "gzip"); assert.equal(copy.MetadataDirective, "REPLACE");
    const actual = copy.Metadata as Record<string, string>;
    for (const key of ["decoded-size", "source-sha256", "stored-sha256"] as const) assert.equal(actual[key], metadata[key]);
  }
  assert.equal((calls[1]!.Metadata as Record<string, string>)["retained-source-note"], "unchanged");
  assert.equal(calls[0]!.CopySourceIfMatch, '"source-etag"'); assert.equal(calls[1]!.CopySourceIfMatch, undefined);
});
