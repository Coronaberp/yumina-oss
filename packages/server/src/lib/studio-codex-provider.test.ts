import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, apiKeys, worlds, agentRuns } from "../db/schema.js";
import { env } from "./env.js";
import { encryptApiKey } from "./crypto.js";
import { resolveStudioNsfwProvider } from "./studio-nsfw-provider.js";
import type { AppEnv } from "./types.js";
import { apiKeyRoutes } from "../routes/api-keys.js";
import { agentRoutes } from "../routes/agent.js";

test("Studio defaults to shared Codex and supports each user's eligible endpoint profiles", async t => {
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), fresh = crypto.randomUUID();
  const saved = { ...env }; t.after(() => Object.assign(env, saved));
  env.YUMINA_EDITION = "local"; env.YUMINA_STUDIO_CODEX_ENABLED = true;
  const secret = encryptApiKey("fixture-only");
  await db.insert(user).values([
    { id: owner, email: owner + "@example.test", name: "Owner", preferences: { activeApiKeyId: "codex-qa-story", nsfwApiKeyId: "codex-qa-nsfw", theme: "gold" } },
    { id: other, email: other + "@example.test", name: "Other", preferences: { nsfwApiKeyId: "codex-qa-other" } },
    { id: fresh, email: fresh + "@example.test", name: "Fresh" },
  ]);
  await db.insert(apiKeys).values([
    { id: "codex-qa-nsfw", userId: owner, provider: "custom", label: "My NSFW", baseUrl: "https://nsfw.example/v1", metadata: { defaultModel: "original-model" }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
    { id: "codex-qa-other", userId: other, provider: "custom", label: "Other private profile", baseUrl: "https://other.example/v1", metadata: { defaultModel: "other-model" }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
    { id: "codex-qa-incomplete", userId: owner, provider: "custom", label: "Incomplete", baseUrl: "https://incomplete.example/v1", encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
    { id: "codex-qa-extra", userId: owner, provider: "openai", label: "My other profile", metadata: { defaultModel: "gpt-5.1" }, encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
  ]);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of apiKeyRoutes.routes.filter(r => r.path === "/studio-provider" && ["GET", "PATCH"].includes(r.method))) app.on(route.method, route.path, route.handler);
  const read = async () => (await (await app.request("/studio-provider")).json() as { data: any }).data;
  const patch = (body: unknown) => app.request("/studio-provider", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const prefs = async () => (await db.select().from(user).where(eq(user.id, owner)))[0]!.preferences;
  await t.test("all accounts default to Codex, including accounts without endpoint profiles", async () => {
    for (const id of [owner, other, fresh]) {
      const resolved = await resolveStudioNsfwProvider(id);
      assert.equal(resolved?.model, "codex/gpt-6-luna"); assert.equal(resolved?.providerName, "codex"); assert.equal(resolved?.isByok, true);
    }
  });
  await t.test("picker lists eligible owned profiles with their configured models", async () => {
    const data = await read();
    assert.deepEqual(data.selection, { source: "default" });
    assert.equal(data.current.model, "codex/gpt-6-luna"); assert.equal(data.current.reasoningEffort, "max");
    assert.deepEqual(data.profiles.filter((p: any) => p.selection.source === "profile").map((p: any) => [p.selection.profileId, p.model]).sort(), [
      ["codex-qa-extra", "openai/gpt-5.1"], ["codex-qa-nsfw", "custom/original-model"],
    ]);
    assert.ok(!JSON.stringify(data).includes("fixture-only"));
    assert.ok(!JSON.stringify(data).includes("Other private profile"));
  });
  await t.test("selecting NSFW changes only the agent's connection and persists", async () => {
    const response = await patch({ source: "nsfw" }); assert.equal(response.status, 200);
    assert.equal((await resolveStudioNsfwProvider(owner))?.model, "custom/original-model");
    assert.deepEqual((await read()).selection, { source: "nsfw" });
    assert.equal((await prefs())?.activeApiKeyId, "codex-qa-story"); assert.equal((await prefs())?.nsfwApiKeyId, "codex-qa-nsfw"); assert.equal((await prefs())?.theme, "gold");
  });
  await t.test("any eligible owned profile uses that profile's configured model", async () => {
    assert.equal((await patch({ source: "profile", profileId: "codex-qa-extra" })).status, 200);
    assert.equal((await resolveStudioNsfwProvider(owner))?.model, "openai/gpt-5.1");
    assert.deepEqual((await read()).selection, { source: "profile", profileId: "codex-qa-extra" });
    assert.equal((await resolveStudioNsfwProvider(other))?.model, "codex/gpt-6-luna");
  });
  await t.test("foreign, missing and incomplete profiles cannot override the selection", async () => {
    const before = await prefs();
    for (const profileId of ["codex-qa-other", "missing", "codex-qa-incomplete"]) {
      assert.equal((await patch({ source: "profile", profileId })).status, 400);
      assert.deepEqual(await prefs(), before);
    }
    assert.equal((await patch({ source: "profile", profileId: "codex-qa-extra", model: "different-model" })).status, 400);
  });
  await t.test("returning to default restores shared Codex Max", async () => {
    assert.equal((await patch({ source: "default" })).status, 200);
    assert.equal((await resolveStudioNsfwProvider(owner))?.model, "codex/gpt-6-luna");
  });
  await t.test("expired native approvals stop before executing writes or image jobs", async () => {
    const worldId = crypto.randomUUID();
    await db.insert(worlds).values({ id: worldId, creatorId: owner, name: "Expired proposal QA", schema: { id: worldId, name: "QA", variables: [], rules: [], entries: [] } });
    for (const suffix of ["approve", "generate-image"]) {
      const [run] = await db.insert(agentRuns).values({ userId: owner, worldId, model: "codex/gpt-6-luna", status: "awaiting_approval", maxIterations: 5,
        pendingToolCalls: [{ id: "expired-call", type: "function", function: { name: "generate_image", arguments: '{"prompt":"QA"}' } }],
      }).returning();
      const route = agentRoutes.routes.find(r => r.method === "POST" && r.path === `/:worldId/agent/${suffix}`)!;
      const scoped = new Hono<AppEnv>();
      scoped.use("*", async (c, next) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); });
      scoped.post(`/:worldId/agent/${suffix}`, route.handler);
      const response = await scoped.request(`/${worldId}/agent/${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run!.id, approved: true }) });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { code: string }).code, "CODEX_SESSION_EXPIRED");
      assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]?.status, "error");
    }
  });
  await t.test("disabled or hosted Codex retains ordinary NSFW routing", async () => {
    env.YUMINA_STUDIO_CODEX_ENABLED = false;
    assert.equal((await resolveStudioNsfwProvider(owner))?.model, "custom/original-model");
    env.YUMINA_STUDIO_CODEX_ENABLED = true; env.YUMINA_EDITION = "hosted";
    assert.equal((await resolveStudioNsfwProvider(owner))?.model, "custom/original-model");
  });
});
