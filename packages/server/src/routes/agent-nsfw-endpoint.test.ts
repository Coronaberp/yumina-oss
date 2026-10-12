import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, agentRuns, user, worlds } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { agentRoutes } from "./agent.js";
import type { AppEnv } from "../lib/types.js";

test("Little Idot start and continuations use the selected NSFW provider", async t => {
  const owner = crypto.randomUUID(), world = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Studio QA", email: `${owner}@example.test` });
  await db.insert(worlds).values({ id: world, creatorId: owner, name: "Studio QA", schema: { id: world, name: "Studio QA", entries: [], variables: [], rules: [], components: [], audioTracks: [] } });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of agentRoutes.routes.filter(r => r.method === "POST" && ["/:worldId/agent/start", "/:worldId/agent/approve", "/:worldId/agent/generate-image"].includes(r.path))) app.post(route.path, route.handler);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("No provider call is permitted"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const post = (suffix: string, body: unknown) => app.request(`/${world}/agent/${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await t.test("missing endpoint shows an actionable error and makes no generation call", async () => {
    const response = await post("start", { message: "Hello", model: "custom/client-sfw-model" });
    assert.equal(response.status, 400);
    const body = await response.json() as { code: string; error: string };
    assert.equal(body.code, "STUDIO_NSFW_ENDPOINT_REQUIRED");
    assert.match(body.error, /NSFW provider/);
  });
  await t.test("approve, reject, and image follow-up failures leave their pending run recoverable", async () => {
    for (const [suffix, approved] of [["approve", true], ["approve", false], ["generate-image", true]] as const) {
      const [run] = await db.insert(agentRuns).values({ worldId: world, userId: owner, model: "custom/old-sfw-model", status: "awaiting_approval", maxIterations: 5, pendingToolCalls: [{ id: "tool", type: "function", function: { name: "generate_image", arguments: '{"prompt":"Test"}' } }] }).returning();
      const response = await post(suffix, { runId: run!.id, approved });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "STUDIO_NSFW_ENDPOINT_REQUIRED");
      const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      assert.equal(saved!.status, "awaiting_approval");
      assert.equal(saved!.pendingToolCalls?.length, 1);
    }
  });
  await t.test("a valid run and continuation ignore client, SFW, and obsolete Studio selections", async () => {
    const key = encryptApiKey("nsfw-route-test-key");
    const profileId = crypto.randomUUID();
    const fallbackId = crypto.randomUUID();
    await db.insert(apiKeys).values([
      { id: profileId, userId: owner, provider: "custom", baseUrl: "https://selected.example/v1", metadata: { defaultModel: "studio-model", contextWindow: 65536 }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
      { id: fallbackId, userId: owner, provider: "custom", baseUrl: "https://fallback.example/v1", metadata: { defaultModel: "fallback-model" }, encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag },
    ]);
    await db.update(user).set({ preferences: { activeApiKeyId: fallbackId, studioApiKeyId: fallbackId, nsfwApiKeyId: profileId, preferredProvider: "official" } }).where(eq(user.id, owner));
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      assert.equal(String(url), "https://selected.example/v1/chat/completions");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, "studio-model");
      const estimatedInput = Math.ceil((JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length) / 4);
      assert.ok(estimatedInput + request.max_tokens <= 65536, "Little Idot input, tools and output fit the saved endpoint context");
      return new Response('data: {"choices":[{"delta":{"content":"Hello. How can I help?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":6}}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const response = await post("start", { message: "Hello", model: "custom/client-sfw-model" });
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.ok(events.includes("Hello. How can I help?"));
    assert.ok(calls.some(url => url.endsWith("/chat/completions")));
    assert.ok(calls.every(url => url.startsWith("https://selected.example/")));
    const runId = response.headers.get("X-Agent-Run-Id");
    const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId!));
    assert.equal(saved!.model, "custom/studio-model");
    const [paused] = await db.insert(agentRuns).values({ worldId: world, userId: owner, model: "custom/old-sfw-model", status: "awaiting_approval", maxIterations: 5, messages: [{ role: "user", content: "A pending change" }], pendingToolCalls: [{ id: "tool", type: "function", function: { name: "generate_image", arguments: '{"prompt":"Test"}' } }] }).returning();
    const before = calls.filter(url => url.endsWith("/chat/completions")).length;
    const continuation = await post("approve", { runId: paused!.id, approved: false });
    assert.equal(continuation.status, 200, await continuation.clone().text());
    assert.ok((await continuation.text()).includes("Hello. How can I help?"));
    assert.ok(calls.filter(url => url.endsWith("/chat/completions")).length > before);
    assert.ok(calls.every(url => url.startsWith("https://selected.example/")));
    const [continued] = await db.select().from(agentRuns).where(eq(agentRuns.id, paused!.id));
    assert.equal(continued!.model, "custom/studio-model");
    await db.update(apiKeys).set({ metadata: { defaultModel: "studio-model", contextWindow: 512 } }).where(eq(apiKeys.id, profileId));
    const callsBeforeOversize = calls.length;
    const oversize = await post("start", { message: "A request that cannot fit the endpoint." });
    const oversizeEvents = await oversize.text();
    assert.ok(oversizeEvents.includes("exceeds the endpoint"), oversizeEvents);
    assert.equal(calls.length, callsBeforeOversize, "An oversized helper request never reaches the model");
  });
});
