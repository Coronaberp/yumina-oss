import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../lib/types.js";

process.env.DATABASE_URL = "";
process.env.DATABASE_READ_URL = "";
process.env.REDIS_URL = "";
process.env.PGLITE_DATA_DIR = "memory://";
process.env.BETTER_AUTH_SECRET = "openrouter-providers-isolated-test-secret";
const { db } = await import("../db/index.js");
const { apiKeys } = await import("../db/schema.js");
const { encryptApiKey } = await import("../lib/crypto.js");
const { apiKeyRoutes } = await import("./api-keys.js");
const originalFetch = globalThis.fetch;
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("user", { id: "owner" } as never); await next(); });
for (const [method, path] of [["GET", "/:id/openrouter-providers"], ["PATCH", "/:id"]] as const) {
  const handler = apiKeyRoutes.routes.find(route => route.method === method && route.path === path)?.handler;
  if (handler) app.on(method, path, handler);
}
const request = (model = "deepseek/deepseek-v3.2") => app.request(`/key/openrouter-providers?model=${encodeURIComponent(model)}`);
const patch = (openRouterProviders: unknown) => app.request("/key", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openRouterProviders }) });

before(async () => {
  await db.execute(sql`CREATE TABLE api_keys (id text PRIMARY KEY, user_id text NOT NULL, provider text NOT NULL, encrypted_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL, label text NOT NULL DEFAULT 'Default', base_url text, metadata jsonb, created_at timestamp DEFAULT now())`);
});
beforeEach(async () => {
  await db.delete(apiKeys);
  const encrypted = encryptApiKey("test-only-key");
  await db.insert(apiKeys).values({ id: "key", userId: "owner", provider: "openrouter", encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag, metadata: { defaultModel: "deepseek/deepseek-v3.2", reasoningEffort: "low" } });
});
after(async () => {
  globalThis.fetch = originalFetch;
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close();
});

test("provider discovery exposes exact endpoint slugs and no key material", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-only-key");
    return Response.json({ data: { endpoints: [
      { provider_name: "Cohere", tag: "cohere", context_length: 163840, pricing: { prompt: "0.0000002", completion: "0.0000004" } },
      { provider_name: "DeepInfra", tag: "deepinfra/turbo", context_length: 163840 },
      { provider_name: "DeepInfra", tag: "deepinfra/turbo" },
      { provider_name: "Invalid", tag: "" },
    ] } });
  };
  const response = await request();
  assert.equal(response.status, 200);
  const result = await response.json() as { data: { providers: { slug: string; name: string }[] } };
  assert.deepEqual(result.data.providers.map(({ slug, name }) => ({ slug, name })), [{ slug: "cohere", name: "Cohere" }, { slug: "deepinfra/turbo", name: "DeepInfra" }]);
  assert.ok(!JSON.stringify(result).includes("test-only-key"));
});

test("saving provider restrictions persists per-model choices and clearing restores account defaults", async () => {
  assert.equal((await patch({ "deepseek/deepseek-v3.2": ["cohere", "cohere", "deepinfra/turbo"] })).status, 200);
  const [saved] = await db.select().from(apiKeys);
  assert.deepEqual(saved?.metadata, { defaultModel: "deepseek/deepseek-v3.2", reasoningEffort: "low", openRouterProviders: { "deepseek/deepseek-v3.2": ["cohere", "deepinfra/turbo"] } });
  assert.equal((await patch({})).status, 200);
  const [cleared] = await db.select().from(apiKeys);
  assert.deepEqual(cleared?.metadata?.openRouterProviders, {});
});

test("provider restrictions reject invalid payloads and other providers", async () => {
  for (const invalid of [null, [], { "deepseek/deepseek-v3.2": "cohere" }, { "deepseek/deepseek-v3.2": [] }, { "deepseek/deepseek-v3.2": [""] }, { "deepseek/deepseek-v3.2": ["Cohere display name"] }, { "../bad": ["cohere"] }]) assert.equal((await patch(invalid)).status, 400);
  await db.update(apiKeys).set({ provider: "openai" }).where(eq(apiKeys.id, "key"));
  assert.equal((await patch({ "deepseek/deepseek-v3.2": ["cohere"] })).status, 400);
  assert.equal((await request()).status, 400);
});

test("discovery rejects foreign profiles and invalid model paths before fetching", async () => {
  globalThis.fetch = async () => { throw new Error("No upstream request expected"); };
  assert.equal((await request("../../keys")).status, 400);
  await db.update(apiKeys).set({ userId: "someone-else" }).where(eq(apiKeys.id, "key"));
  assert.equal((await request()).status, 404);
});

test("provider discovery reports upstream failure without changing saved routing", async () => {
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal((await request()).status, 502);
  const [saved] = await db.select().from(apiKeys);
  assert.equal(saved?.metadata?.openRouterProviders, undefined);
});
