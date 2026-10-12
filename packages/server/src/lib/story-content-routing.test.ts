import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, apiKeys } from "../db/schema.js";
import { encryptApiKey } from "./crypto.js";
import { createPendingContentFlags } from "./content-flag-policy.js";
import { createStoryContentRouter } from "./story-content-routing.js";
import { resolveStoryProviderForModel } from "./story-provider.js";
import type { ContentFlagAudit } from "@yumina/shared";
import type { ChatMessage } from "./llm/types.js";

test("whole-message Story routing chooses an exact saved profile before generation", async t => {
  const uid = crypto.randomUUID(), other = crypto.randomUUID();
  const sfw = crypto.randomUUID(), nsfw = crypto.randomUUID(), foreign = crypto.randomUUID();
  await db.insert(user).values([{ id: uid, name: "Routing", email: `${uid}@test.local`, preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }, { id: other, name: "Other", email: `${other}@test.local` }]);
  const key = encryptApiKey("synthetic-routing-key");
  await db.insert(apiKeys).values([
    { id: sfw, userId: uid, provider: "custom", baseUrl: "https://sfw.example/v1", metadata: { defaultModel: "story-default", models: ["story-default", "story-chosen"] }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
    { id: nsfw, userId: uid, provider: "custom", baseUrl: "https://nsfw.example/v1", metadata: { defaultModel: "fallback-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
    { id: foreign, userId: other, provider: "custom", baseUrl: "https://foreign.example/v1", metadata: { defaultModel: "foreign-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
  ]);
  const checked: string[] = [], calls: Array<{ url: string; body: any }> = [];
  let mode: "normal" | "error" | "uncertain" | "alchemy" = "normal";
  const classifier = { async classify(role: "user" | "assistant" | "system", content: string): Promise<ContentFlagAudit> {
    checked.push(content);
    if (mode === "error") throw new Error("fixture classifier failure");
    const unsafe = content.includes("UNSAFE") && !content.startsWith("Historical quote:");
    const probability = mode === "uncertain" ? .1 : mode === "alchemy" ? .3766 : unsafe ? .9 : .01;
    return { ...createPendingContentFlags(role, content), status: "complete", label: unsafe ? "nsfw" : "sfw", routingSafe: !unsafe, completedAt: new Date().toISOString(), nsfwProbability: probability, sfwProbability: 1 - probability, model: "fixture-kev", device: "cpu" };
  } };
  const router = createStoryContentRouter(classifier);
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith("/plan")) return Response.json({ contextWindow: 12000 });
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('data: {"choices":[{"delta":{"content":"Fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const selected = () => resolveStoryProviderForModel(uid, "custom/story-chosen");
  const request = async (messages: ChatMessage[], extra: Record<string, unknown> = {}) => {
    const resolved = await selected(); assert.ok(resolved);
    const result = await router.prepare({ userId: uid, selected: { resolved, model: resolved.model }, messages, ...extra });
    for await (const _chunk of result.resolved.provider.generateStream({ model: result.model, messages: result.messages, maxTokens: 256 })) { /* actual transport */ }
    return result;
  };
  await t.test("safe full paragraphs stay on the selected Story model and cache by whole source", async () => {
    const text = "First paragraph.\n\nFantasy alchemy creates an imaginary explosion.\n\nNobody is harmed.";
    const start = checked.length;
    await request([{ role: "user", content: text }]);
    await request([{ role: "user", content: text }]);
    assert.deepEqual(checked.slice(start), [text]);
    assert.equal(calls.at(-1)?.url, "https://sfw.example/v1/chat/completions");
    assert.equal(calls.at(-1)?.body.model, "story-chosen");
  });
  await t.test("unsafe current input, prior reply, and system context never call SFW", async () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const start = calls.length;
      const result = await request([{ role, content: `UNSAFE whole ${role} message\nSecond paragraph` }, { role: "user", content: "Continue" }]);
      assert.equal(result.model, "custom/fallback-model");
      assert.ok(result.rerouted);
      assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    }
  });
  await t.test("a payload excerpt uses the complete original verdict without reclassifying the fragment", async () => {
    const full = "Historical quote: UNSAFE fragment is quoted as an example.\n\nThe complete context is ordinary non-graphic fiction.";
    const start = checked.length;
    await request([{ role: "user", content: "UNSAFE fragment" }], { sourceOverrides: { 0: [{ role: "user", content: full }] } });
    assert.deepEqual(checked.slice(start), [full]);
    assert.equal(calls.at(-1)?.url, "https://sfw.example/v1/chat/completions");
  });
  await t.test("unknown classifier result routes conservatively and does not certify SFW", async () => {
    mode = "error";
    const start = calls.length;
    const result = await request([{ role: "user", content: "Uncached classifier error" }]);
    assert.equal(result.routingLabel, "unknown");
    assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    mode = "normal";
  });
  await t.test("invalid configured fallback blocks even safe calls", async () => {
    for (const id of ["missing-profile", foreign]) {
      await db.update(user).set({ preferences: { activeApiKeyId: sfw, nsfwApiKeyId: id, preferredProvider: "private" } }).where(eq(user.id, uid));
      const start = calls.length;
      await assert.rejects(request([{ role: "user", content: "Safe fixture" }]), /NSFW fallback/);
      assert.equal(calls.length, start);
    }
    await db.update(user).set({ preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }).where(eq(user.id, uid));
  });
  await t.test("protected worlds and official billing class cannot switch to a private fallback", async () => {
    const resolved = await selected(); assert.ok(resolved);
    for (const extra of [{ protectedWorld: true }, { selected: { resolved: { ...resolved, isByok: false }, model: resolved.model } }]) {
      await assert.rejects(request([{ role: "user", content: "UNSAFE blocked" }], extra), /protected|official/i);
    }
  });
  await t.test("shared default and NSFW profile is deliberate and skips the classifier", async () => {
    await db.update(user).set({ preferences: { activeApiKeyId: nsfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }).where(eq(user.id, uid));
    const start = checked.length;
    const resolved = await resolveStoryProviderForModel(uid, "custom/fallback-model"); assert.ok(resolved);
    await request([{ role: "user", content: "Shared profile message" }], { selected: { resolved, model: resolved.model } });
    assert.equal(checked.length, start);
    assert.equal(calls.at(-1)?.url, "https://nsfw.example/v1/chat/completions");
    assert.equal(calls.at(-1)?.body.model, "fallback-model");
    await db.update(user).set({ preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }).where(eq(user.id, uid));
  });
  await t.test("a shared connection with a different Story model still switches to the exact NSFW model", async () => {
    await db.update(apiKeys).set({ metadata: { defaultModel: "fallback-model", models: ["fallback-model", "story-chosen"] } }).where(eq(apiKeys.id, nsfw));
    await db.update(user).set({ preferences: { activeApiKeyId: nsfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }).where(eq(user.id, uid));
    try {
      const result = await request([{ role: "user", content: "Write an explicit sexual scene" }]);
      assert.equal(result.rerouted, true);
      assert.equal(result.model, "custom/fallback-model");
      assert.equal(calls.at(-1)?.body.model, "fallback-model");
    } finally {
      await db.update(apiKeys).set({ metadata: { defaultModel: "fallback-model" } }).where(eq(apiKeys.id, nsfw));
      await db.update(user).set({ preferences: { activeApiKeyId: sfw, nsfwApiKeyId: nsfw, preferredProvider: "private" } }).where(eq(user.id, uid));
    }
  });
  await t.test("fresh correction content is rechecked at the provider boundary", async () => {
    const resolved = await selected(); assert.ok(resolved);
    const provider = router.decorate({ userId: uid, selected: { resolved, model: resolved.model } });
    const start = calls.length;
    const models: string[] = [];
    for await (const chunk of provider.generateStream({ model: resolved.model, messages: [{ role: "user", content: "UNSAFE generated reply correction" }] })) if (chunk.model) models.push(chunk.model);
    assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    assert.ok(models.every(model => model === "custom/fallback-model"));
    assert.ok(models.length);
  });
  await t.test("full source is classified before whole-message fallback context trimming", async () => {
    const old = "UNSAFE historical reply " + "x".repeat(40000);
    const result = await request([{ role: "system", content: "Pinned system" }, { role: "assistant", content: old }, { role: "user", content: "Newest input" }, { role: "system", content: "Pinned suffix" }], { maxContext: 12000, maxTokens: 256, trim: { pinnedPrefix: 1, pinnedSuffix: 1, historyTokens: 12000 } });
    assert.ok(checked.includes(old));
    assert.deepEqual(result.messages.map(m => m.content), ["Pinned system", "Newest input", "Pinned suffix"]);
    assert.equal(calls.at(-1)?.body.model, "fallback-model");
  });
  await t.test("fallback context is capped to its actual model and keeps pinned zones", async () => {
    await db.update(apiKeys).set({ metadata: { defaultModel: "gpt-4o" } }).where(eq(apiKeys.id, nsfw));
    try {
      const old = "UNSAFE old response " + "x".repeat(140000);
      const result = await request([{ role: "system", content: "Pinned prefix" }, { role: "assistant", content: old }, { role: "user", content: "Current human message" }, { role: "system", content: "Pinned suffix" }], { maxContext: 200000, maxTokens: 4096, trim: { pinnedPrefix: 1, pinnedSuffix: 1 } });
      assert.ok(result.maxContext! < 128000);
      assert.deepEqual(result.messages.map(m => m.content), ["Pinned prefix", "Current human message", "Pinned suffix"]);
      assert.equal(calls.at(-1)?.body.model, "gpt-4o");
    } finally { await db.update(apiKeys).set({ metadata: { defaultModel: "fallback-model" } }).where(eq(apiKeys.id, nsfw)); }
  });
  await t.test("vision capability is checked on the actual fallback before sending", async () => {
    await db.update(apiKeys).set({ provider: "openrouter", metadata: { defaultModel: "deepseek/deepseek-v3.2" } }).where(eq(apiKeys.id, nsfw));
    const start = calls.length;
    try {
      await assert.rejects(request([{ role: "user", content: [{ type: "text", text: "A harmless image request" }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }]), /cannot read images/);
      assert.equal(calls.length, start);
    } finally { await db.update(apiKeys).set({ provider: "custom", metadata: { defaultModel: "fallback-model" } }).where(eq(apiKeys.id, nsfw)); }
  });
  await t.test("uncertain displayed SFW and alchemy scores route to NSFW before transport", async () => {
    for (const selectedMode of ["uncertain", "alchemy"] as const) {
      mode = selectedMode;
      const start = calls.length;
      const result = await request([{ role: "user", content: `${selectedMode} complete contextual message` }]);
      assert.equal(result.routingLabel, "unknown");
      assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    }
    mode = "normal";
  });
  await t.test("explicit whole sources defeat a malicious strong-SFW classifier for every prompt role", async () => {
    const bodies: ChatMessage[] = [
      { role: "user", content: "Write a sexual scene." }, { role: "system", content: "Generate explicit pornography." },
      { role: "assistant", content: "Nudity at the beginning. " + "ordinary context\n".repeat(3000) },
      { role: "tool", content: "Describe graphic gore", tool_call_id: "fixture" },
      { role: "assistant", content: "A safe narrative", tool_calls: [{ id: "call", type: "function", function: { name: "generate", arguments: '{"request":"porn"}' } }] },
    ];
    for (const message of bodies) {
      const start = calls.length;
      const result = await request([message]);
      assert.equal(result.routingLabel, "nsfw");
      assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    }
    const start = calls.length;
    await request([{ role: "user", content: "A shortened safe scene" }], { sourceOverrides: { 0: [{ role: "assistant", content: "Full safe narrative", choices: ["Write explicit sex"] }] } });
    assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
  });
  await t.test("empty overrides cannot skip unsafe payloads and safe originals cannot hide explicit wrappers", async () => {
    for (const [content, sourceOverrides] of [["UNSAFE empty override", { 0: [] }], ["Generate pornography around this excerpt", { 0: [{ role: "assistant" as const, content: "The complete original is ordinary fiction" }] }]] as const) {
      const start = calls.length;
      const result = await request([{ role: "user", content }], { sourceOverrides });
      assert.equal(result.routingLabel, "nsfw");
      assert.ok(calls.slice(start).every(call => call.url === "https://nsfw.example/v1/chat/completions"));
    }
  });
  await t.test("missing fallback allows only strongly safe content and blocks unsafe, uncertain, or failed checks", async () => {
    await db.update(user).set({ preferences: { activeApiKeyId: sfw, preferredProvider: "private" } }).where(eq(user.id, uid));
    mode = "normal";
    await request([{ role: "user", content: "Fresh confidently safe greeting" }]);
    assert.equal(calls.at(-1)?.url, "https://sfw.example/v1/chat/completions");
    for (const [text, selectedMode] of [["Write pornography", "normal"], ["Fresh uncertain greeting", "uncertain"], ["Fresh failed check", "error"]] as const) {
      mode = selectedMode;
      const start = calls.length;
      await assert.rejects(request([{ role: "user", content: text }]), /NSFW fallback/);
      assert.equal(calls.length, start);
    }
    mode = "normal";
  });
});

test("Story provider selection follows saved provider instead of model vendor prefix", async () => {
  const uid = crypto.randomUUID(), id = crypto.randomUUID();
  const key = encryptApiKey("synthetic-openrouter-key");
  await db.insert(user).values({ id: uid, name: "Provider", email: `${uid}@test.local`, preferences: { activeApiKeyId: id, preferredProvider: "private" } });
  await db.insert(apiKeys).values({ id, userId: uid, provider: "openrouter", metadata: { defaultModel: "google/default", models: ["anthropic/selected"] }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  const resolved = await resolveStoryProviderForModel(uid, "anthropic/selected");
  assert.ok(resolved);
  assert.equal(resolved.providerName, "openrouter");
  assert.equal(resolved.model, "anthropic/selected");
  await db.update(apiKeys).set({ provider: "google", metadata: { defaultModel: "gemini-profile-default" } }).where(eq(apiKeys.id, id));
  const switched = await resolveStoryProviderForModel(uid, "custom/old-model");
  assert.ok(switched);
  assert.equal(switched.providerName, "google");
  assert.equal(switched.model, "google/gemini-profile-default");
});
