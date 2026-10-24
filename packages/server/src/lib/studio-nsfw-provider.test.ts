import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user, providerAttempts } from "../db/schema.js";
import { encryptApiKey } from "./crypto.js";

test("Little Idot always resolves the selected owned NSFW profile", async t => {
  const { resolveStudioNsfwProvider } = await import("./studio-nsfw-provider.js");
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  await db.insert(user).values([
    { id: owner, name: "Studio", email: `${owner}@example.test`, preferences: { activeApiKeyId: "sfw", nsfwApiKeyId: "nsfw", preferredProvider: "official" } },
    { id: other, name: "Other", email: `${other}@example.test`, preferences: { nsfwApiKeyId: "nsfw" } },
  ]);
  const key = encryptApiKey("studio-test-key");
  await db.insert(apiKeys).values([
    { id: "sfw", userId: owner, provider: "custom", baseUrl: "https://sfw.example/v1", metadata: { defaultModel: "fast-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
    { id: "nsfw", userId: owner, provider: "custom", baseUrl: "https://nsfw.example/v1", metadata: { defaultModel: "fallback-model", includeBody: { top_k: 8 } }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
  ]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  await t.test("generation uses the NSFW URL and configured model even when official/SFW is active", async () => {
    const resolved = await resolveStudioNsfwProvider(owner);
    assert.ok(resolved);
    assert.equal(resolved.model, "custom/fallback-model");
    assert.equal(resolved.isByok, true);
    let called = false;
    globalThis.fetch = (async (url, init) => {
      called = true;
      assert.equal(String(url), "https://nsfw.example/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "fallback-model");
      assert.equal(body.top_k, 8);
      return new Response('data: {"choices":[{"delta":{"content":"Fixture response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    for await (const _chunk of resolved.provider.generateStream({ model: resolved.model, messages: [{ role: "user", content: "Test fixture" }] })) { /* consume the actual request */ }
    assert.equal(called, true);
    const [receipt] = await db.select().from(providerAttempts).where(eq(providerAttempts.userId, owner));
    assert.ok(receipt);
    assert.equal(receipt.profileId, "nsfw");
    assert.equal(receipt.completionTokens, 1);
  });
  await t.test("obsolete Studio preferences never override the NSFW connection", async () => {
    for (const studioApiKeyId of ["sfw", null, "missing"]) {
      await db.update(user).set({ preferences: { activeApiKeyId: "sfw", nsfwApiKeyId: "nsfw", studioApiKeyId } }).where(eq(user.id, owner));
      const resolved = await resolveStudioNsfwProvider(owner);
      assert.ok(resolved);
      assert.equal(resolved.model, "custom/fallback-model");
      assert.equal(resolved.profileId, "nsfw");
    }
    await db.update(user).set({ preferences: { studioApiKeyId: "sfw" } }).where(eq(user.id, owner));
    assert.equal(await resolveStudioNsfwProvider(owner), null);
  });
  await t.test("every supported saved provider can be selected with its own default model", async () => {
    for (const [provider, rawModel, expectedModel] of [
      ["custom", "custom/chosen-model", "custom/chosen-model"],
      ["openrouter", "anthropic/chosen-model", "anthropic/chosen-model"],
      ["anthropic", "chosen-model", "anthropic/chosen-model"],
      ["openai", "chosen-model", "openai/chosen-model"],
      ["google", "chosen-model", "google/chosen-model"],
      ["ollama", "chosen-model", "ollama/chosen-model"],
    ]) {
      const id = crypto.randomUUID();
      const secret = encryptApiKey(provider === "ollama" ? "http://localhost:11434" : "provider-fixture-key");
      await db.insert(apiKeys).values({ id, userId: owner, provider, baseUrl: provider === "custom" ? "https://selected.example/v1" : null, metadata: { defaultModel: rawModel }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag });
      await db.update(user).set({ preferences: { studioApiKeyId: "sfw", nsfwApiKeyId: id } }).where(eq(user.id, owner));
      const resolved = await resolveStudioNsfwProvider(owner);
      assert.ok(resolved, provider);
      assert.equal(resolved.providerName, provider);
      assert.equal(resolved.model, expectedModel);
    }
  });
  await t.test("foreign and missing assignments fail closed without a provider call", async () => {
    globalThis.fetch = (async () => { throw new Error("No outbound call is permitted"); }) as typeof fetch;
    assert.equal(await resolveStudioNsfwProvider(other), null);
    for (const preferences of [{ activeApiKeyId: "sfw" }, { activeApiKeyId: "sfw", nsfwApiKeyId: "missing" }]) {
      await db.update(user).set({ preferences }).where(eq(user.id, owner));
      assert.equal(await resolveStudioNsfwProvider(owner), null);
    }
  });
  await t.test("missing model or URL cannot silently use a SFW model or connection", async () => {
    await db.update(user).set({ preferences: { activeApiKeyId: "sfw", nsfwApiKeyId: "nsfw" } }).where(eq(user.id, owner));
    await db.update(apiKeys).set({ metadata: {} }).where(eq(apiKeys.id, "nsfw"));
    assert.equal(await resolveStudioNsfwProvider(owner), null);
    await db.update(apiKeys).set({ metadata: { defaultModel: "fallback-model" }, baseUrl: null }).where(eq(apiKeys.id, "nsfw"));
    assert.equal(await resolveStudioNsfwProvider(owner), null);
  });
});
