import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { apiKeyRoutes } from "./api-keys.js";
import { resolveSavedProfileProvider } from "../lib/saved-profile-provider.js";
import type { AppEnv } from "../lib/types.js";

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("user", { id: "context-owner" } as never); await next(); });
for (const route of apiKeyRoutes.routes) {
  if (route.method === "PATCH" && route.path === "/:id") app.patch(route.path, route.handler);
  if (route.method === "POST" && route.path === "/") app.post(route.path, route.handler);
}
const patch = (body: unknown) => app.request("/context-profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
before(async () => { await db.insert(user).values([{ id: "context-owner", name: "Context owner", email: "context-owner@test.invalid" }, { id: "someone-else", name: "Other account", email: "context-other@test.invalid" }]); });
beforeEach(async () => {
  await db.delete(apiKeys);
  const key = encryptApiKey("fixture-only");
  await db.insert(apiKeys).values({ id: "context-profile", userId: "context-owner", provider: "custom", baseUrl: "https://example.com/v1", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag, metadata: { defaultModel: "qwen3.8", models: ["qwen3.8"], includeBody: { top_k: 4 } } });
});
test("saving and clearing an endpoint context cap preserves other profile metadata and reaches the resolved provider", async () => {
  assert.equal((await patch({ contextWindow: 65536 })).status, 200);
  const [saved] = await db.select().from(apiKeys);
  assert.equal((saved!.metadata as any).contextWindow, 65536);
  assert.deepEqual(saved!.metadata?.includeBody, { top_k: 4 });
  const resolved = await resolveSavedProfileProvider("context-owner", "context-profile");
  assert.equal(await resolved?.provider.getContextWindow?.(), 65536);
  assert.equal((await patch({ contextWindow: null })).status, 200);
  const cleared = await resolveSavedProfileProvider("context-owner", "context-profile");
  assert.equal(await cleared?.provider.getContextWindow?.(), undefined);
});
test("context caps are accepted on non-custom profiles when creating and updating", async () => {
  await db.update(apiKeys).set({ provider: "openai" }).where(eq(apiKeys.id, "context-profile"));
  assert.equal((await patch({ contextWindow: 64000 })).status, 200);
  const response = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", key: "fixture-key", contextWindow: 32000 }) });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  assert.equal(body.data.metadata.contextWindow, 32000);
});
test("invalid endpoint caps are rejected before changing saved metadata", async () => {
  for (const contextWindow of [0, -1, 511, 65536.5, "65536", 2000001]) {
    assert.equal((await patch({ contextWindow })).status, 400, String(contextWindow));
  }
  const [saved] = await db.select().from(apiKeys);
  assert.equal((saved!.metadata as any).contextWindow, undefined);
});
test("another account cannot change a profile's context cap", async () => {
  await db.update(apiKeys).set({ userId: "someone-else" }).where(eq(apiKeys.id, "context-profile"));
  assert.equal((await patch({ contextWindow: 65536 })).status, 404);
});
