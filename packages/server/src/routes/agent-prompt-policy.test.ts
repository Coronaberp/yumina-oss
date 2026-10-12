import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns } from "../db/schema.js";
import { imageGenerationService } from "../lib/image-generation/default.js";
import type { ChatMessage, GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { getSkillContent } from '../lib/studio-skills/index.js';
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { buildStudioSummaryPrompt } from "../lib/studio-context-compaction.js";
import { streamAgentLoop } from "./agent.js";

async function captureRequest(configured: boolean, check: (request: GenerateParams) => void, options: { language?: unknown; messages?: ChatMessage[]; iteration?: number; prelude?: () => Promise<ChatMessage[]>; expectProvider?: boolean } = {}) {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: wid, version: "19.0.0", name: "语言与工具测试", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Prompt policy", email: `${uid}@test.local`, preferences: { language: 'ja', studioOutputLanguage: options.language } });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: rid, worldId: wid, userId: uid, model: "policy-fixture", status: "running" });
  let seen = false;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    check(request); seen = true;
    yield { type: "text", content: "I help you build interactive worlds." };
    yield { type: "done", content: "", stopReason: "end_turn" };
  } };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId: rid, conversationId: rid, worldId: wid, userId: uid, world,
    messages: options.messages ?? [{ role: "user", content: "What can you help me build?" }, { role: "assistant", content: "我可以帮你构建世界。" }, { role: "user", content: "Tell me more." }],
    model: "policy-fixture", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: options.iteration ?? 0, maxIterations: (options.iteration ?? 0) + 1, tools: STUDIO_TOOLS, prelude: options.prelude }));
  try {
    if (configured) await imageGenerationService.updateConfig(uid, { provider: "forgeneo", enabled: true, baseUrl: "https://forge.example.com", model: "checkpoint.safetensors", apiKey: "neo:fixture-not-called", makeActive: true });
    const response = await app.request("/test");
    const text = await response.text();
    assert.equal(response.status, 200); assert.doesNotMatch(text, /event: error/);
    assert.equal(seen, options.expectProvider ?? true, "Whether the main agent provider should be called");
    const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, rid));
    return { text, saved: saved! };
  } finally { await db.delete(user).where(eq(user.id, uid)); }
}

test("a refused NSFW image completes with a persisted user message without calling the main agent", async () => {
  const { text, saved } = await captureRequest(false, () => assert.fail("A refused image must not call the main agent"), {
    expectProvider: false,
    prelude: async () => [{ role: "tool", tool_call_id: "image-refusal", content: JSON.stringify({ error: "This request is NSFW. Image generation is disabled for NSFW requests." }) }],
  });
  assert.match(text, /Image generation is disabled for NSFW requests. No image was generated./);
  assert.equal(saved.status, "completed");
  assert.equal(saved.textContent, "Image generation is disabled for NSFW requests. No image was generated.");
  assert.equal(saved.committedTurns?.at(-1)?.textContent, saved.textContent);
  assert.equal(saved.committedTurns?.at(-1)?.lane, "answer");
});

test("an earlier NSFW image refusal does not block a later safe request", async () => {
  await captureRequest(false, () => {}, { messages: [
    { role: "tool", tool_call_id: "old-image", content: JSON.stringify({ error: "This request is NSFW. Image generation is disabled for NSFW requests." }) },
    { role: "user", content: "Help me write a safe scene instead." },
  ] });
});
const promptText = (request: GenerateParams) => request.messages.filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");

test("the agent defaults to English despite other-language world names and assistant history", async () => {
  await captureRequest(false, request => {
    assert.match(promptText(request), /Respond in English by default/);
    assert.match(promptText(request), /only when the creator explicitly requests/i);
    assert.match(promptText(request), /earlier assistant replies/i);
    assert.ok(request.messages.some(message => message.content === "我可以帮你构建世界。"), "Existing history is preserved");
  });
});

test("disabled image generation disappears from the actual provider tools and skill instructions", async () => {
  await captureRequest(false, request => {
    const names = request.tools!.map(tool => tool.function.name);
    assert.ok(!names.includes("generate_image")); assert.ok(!names.includes("generate_images"));
    assert.ok(names.includes("list_assets") && names.includes("edit_vn_assets") && names.includes("get_image_sources"), "Owned art and source setup remain available");
    assert.doesNotMatch(promptText(request), /\bgenerate_images?\b|character image bindings v1/);
  });
});

test("a configured personal generator keeps its single-image tool without advertising disabled platform batches", async () => {
  await captureRequest(true, request => {
    const names = request.tools!.map(tool => tool.function.name);
    assert.ok(names.includes("generate_image")); assert.ok(!names.includes("generate_images"));
    assert.match(promptText(request), /\bgenerate_image\b/); assert.doesNotMatch(promptText(request), /\bgenerate_images\b|character image bindings v1/);
    assert.match(promptText(request), /If the request is NSFW, DO NOT USE IMAGE GENERATION/);
    assert.match(promptText(request), /Tell the user plainly: "Image generation is disabled for NSFW requests\."/);
    assert.doesNotMatch(promptText(request), /Explicit adult character art is in-scope/);
  });
});

test("Studio compaction also defaults to English and preserves explicit language requests as context", () => {
  const history = [{ role: "assistant" as const, content: "此前的工作摘要。" }, { role: "user" as const, content: "Please write the story in Japanese." }, { role: "user" as const, content: "/summarize" }];
  const prompt = buildStudioSummaryPrompt(history);
  assert.match(String(prompt[0]!.content), /Respond in English by default/);
  assert.match(String(prompt[0]!.content), /only when the creator explicitly requests/i);
  assert.deepEqual(JSON.parse(String(prompt[1]!.content)), history.slice(0, -1));
});

test('the persisted output language is applied when a Studio run resumes', async () => {
  await captureRequest(false, request => {
    assert.match(promptText(request), /Respond in Japanese by default/);
    assert.doesNotMatch(promptText(request), /Respond in English by default/);
  }, { language: 'ja', iteration: 1 });
});

test('actual compaction requests use the selected language without changing source text', async () => {
  await captureRequest(false, request => {
    assert.match(promptText(request), /Respond in French by default/);
    assert.deepEqual(request.tools, []);
    assert.match(String(request.messages.at(-1)?.content), /保留原文/);
  }, { language: 'fr', messages: [{ role: 'user', content: '保留原文' }, { role: 'user', content: '/summarize' }] });
});

test('on-demand skill loading also removes unavailable generation guidance', () => {
  assert.doesNotMatch(getSkillContent('front-ui')!, /generate_image/);
  assert.match(getSkillContent('front-ui')!, /search_danbooru_images/);
  assert.match(getSkillContent('front-ui', { imageGeneration: true })!, /generate_image/);
});
