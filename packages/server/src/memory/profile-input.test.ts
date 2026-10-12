import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEmbeddingProfileInput,
  publicEmbeddingProfile,
} from "./profile-input.js";

test("embedding configuration validates dimensions and defaults to source behavior", () => {
  assert.deepEqual(
    parseEmbeddingProfileInput({
      baseUrl: "http://127.0.0.1:8000",
      model: " Qwen3-Embedding-0.6B ",
      dimensions: 1024,
    }),
    {
      baseUrl: "http://127.0.0.1:8000",
      model: "Qwen3-Embedding-0.6B",
      dimensions: 1024,
      sendDimensions: false,
    },
  );
  for (const dimensions of [0, 1.5, 16001, "1024"])
    assert.throws(() =>
      parseEmbeddingProfileInput({
        baseUrl: "https://example.test",
        model: "m",
        dimensions,
      }),
    );
  assert.throws(() =>
    parseEmbeddingProfileInput({
      baseUrl: "https://key:secret@example.test",
      model: "m",
      dimensions: 1024,
    }),
  );
  assert.throws(() =>
    parseEmbeddingProfileInput({
      baseUrl: "https://example.test?key=secret",
      model: "m",
      dimensions: 1024,
    }),
  );
});
test("public profile projects explicit fields and never serializes credentials or schema", () => {
  const result = publicEmbeddingProfile(
    {
      id: "p",
      userId: "u",
      schemaName: "shm_secret",
      baseUrl: "https://example.test",
      model: "m",
      dimensions: 1024,
      sendDimensions: false,
      status: "ready",
      revision: 1,
      active: true,
      credential: "secret",
      apiKey: "secret",
    } as never,
    true,
  );
  assert.equal(result.hasKey, true);
  assert.equal("schemaName" in result, false);
  assert.equal("credential" in result, false);
  assert.equal("apiKey" in result, false);
  assert.equal("userId" in result, false);
});
