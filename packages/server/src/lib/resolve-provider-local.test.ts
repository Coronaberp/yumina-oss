import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";

// The isolated launcher supplies an in-memory DB and blocks local credentials.
process.env.YUMINA_EDITION = "local";
await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
const { db } = await import("../db/index.js");
const { apiKeys, user } = await import("../db/schema.js");
const { encryptApiKey } = await import("./crypto.js");
const { resolveProviderForModel, getUserApiKey } = await import("./resolve-provider.js");
const { CustomProvider } = await import("./llm/custom.js");

after(async () => { if ("close" in db.$client) await db.$client.close(); });

test("local Studio resolves its active custom profile without a provider preference", async () => {
  await db.insert(user).values({
    id: "local-owner", name: "Local", email: "local-test@example.com",
    preferences: { activeApiKeyId: "active-custom" },
  });
  const key = encryptApiKey("isolated-test-key");
  await db.insert(apiKeys).values({
    id: "active-custom", userId: "local-owner", provider: "custom",
    baseUrl: "https://api.example.com/v1",
    encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag,
    metadata: { models: ["deepseek-v4-flash-0731"] },
  });

  for (const preferredProvider of [undefined, null, "official", "private"]) {
    await db.update(user).set({
      preferences: { activeApiKeyId: "active-custom", preferredProvider },
    }).where(eq(user.id, "local-owner"));
    const resolved = await resolveProviderForModel("local-owner", "custom/deepseek-v4-flash-0731");
    assert.ok(resolved, `local BYOK must work with preference ${String(preferredProvider)}`);
    assert.equal(resolved.providerName, "custom");
    assert.equal(resolved.isByok, true);
    assert.equal(resolved.apiKeyTier, "byok");
    assert.ok(resolved.provider instanceof CustomProvider);
  }
});

test("local Studio does not resolve another account's custom key", async () => {
  await db.insert(user).values({
    id: "other-owner", name: "Other", email: "other-test@example.com",
    preferences: { activeApiKeyId: "active-custom" },
  });
  assert.equal(await resolveProviderForModel("other-owner", "custom/deepseek-v4-flash-0731"), null);
});

test("story provider fallback does not switch to a newer NSFW profile", async () => {
  await db.insert(user).values({ id: "fallback-owner", name: "Fallback", email: "fallback@example.test", preferences: { nsfwApiKeyId: "nsfw-newer" } });
  for (const [id, value, createdAt] of [["sfw-older", "sfw-test-key", "2026-10-01"], ["nsfw-newer", "nsfw-test-key", "2026-10-02"]]) {
    const key = encryptApiKey(value!);
    await db.insert(apiKeys).values({ id: id!, userId: "fallback-owner", provider: "custom", baseUrl: `https://${id}.example/v1`, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag, createdAt: new Date(createdAt!) });
  }
  assert.equal(await getUserApiKey("fallback-owner", "custom"), "sfw-test-key");
  const resolved = await resolveProviderForModel("fallback-owner", "custom/story-model");
  assert.ok(resolved);
  const original = globalThis.fetch;
  try {
    let called = false;
    globalThis.fetch = (async url => {
      called = true;
      assert.equal(String(url), "https://sfw-older.example/v1/chat/completions");
      return new Response('data: {"choices":[{"delta":{"content":"Fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    for await (const _chunk of resolved.provider.generateStream({ model: "custom/story-model", messages: [{ role: "user", content: "Fixture" }] })) { /* capture the real provider request */ }
    assert.equal(called, true);
  } finally { globalThis.fetch = original; }
});
