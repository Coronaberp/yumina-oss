import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { apiKeyRoutes } from "./api-keys.js";
import type { AppEnv } from "../lib/types.js";

test("SFW and NSFW endpoint assignments preserve the legacy connection and validate ownership", async t => {
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  await db.insert(user).values([
    { id: owner, name: "Endpoint QA", email: `${owner}@example.test`, preferences: { activeApiKeyId: "sfw-key", theme: "gold" } },
    { id: other, name: "Other", email: `${other}@example.test` },
  ]);
  const secret = encryptApiKey("test-key-only-never-return");
  await db.insert(apiKeys).values([
    { id: "sfw-key", userId: owner, provider: "custom", label: "Existing", baseUrl: "https://sfw.example/v1", metadata: { defaultModel: "fast-model" }, createdAt: new Date("2026-10-01"), encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
    { id: "nsfw-key", userId: owner, provider: "custom", label: "Fallback", baseUrl: "https://nsfw.example/v1", metadata: { defaultModel: "fallback-model" }, createdAt: new Date("2026-10-02"), encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
    { id: "foreign-key", userId: other, provider: "custom", label: "Private", baseUrl: "https://private.example/v1", encryptedKey: secret.encrypted, keyIv: secret.iv, keyTag: secret.tag },
  ]);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of apiKeyRoutes.routes.filter(r => r.path === "/content-endpoints" && ["GET", "PATCH"].includes(r.method))) app.on(route.method, route.path, route.handler);
  const deletion = apiKeyRoutes.routes.find(r => r.method === "DELETE" && r.path === "/:id")!;
  app.delete("/:id", deletion.handler);
  const get = () => app.request("/content-endpoints");
  const read = async () => await (await get()).json() as { data: { sfwApiKeyId: string | null; nsfwApiKeyId: string | null } };
  const patch = (body: unknown) => app.request("/content-endpoints", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const prefs = async () => (await db.select().from(user).where(eq(user.id, owner)))[0]!.preferences;

  await t.test("current connection is the SFW endpoint without copying or exposing credentials", async () => {
    const response = await get();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, { data: { sfwApiKeyId: "sfw-key", nsfwApiKeyId: null } });
    assert.ok(!JSON.stringify(result).includes("test-key"));
  });
  await t.test("NSFW assignment persists independently and survives a fresh read", async () => {
    const response = await patch({ nsfwApiKeyId: "nsfw-key" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { sfwApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key" } });
    assert.deepEqual((await read()).data, { sfwApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key" });
    assert.equal((await prefs())?.activeApiKeyId, "sfw-key");
    assert.equal((await prefs())?.theme, "gold");
    const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, "sfw-key"));
    assert.equal(existing!.baseUrl, "https://sfw.example/v1");
    assert.equal(existing!.metadata?.defaultModel, "fast-model");
    assert.equal(existing!.encryptedKey, secret.encrypted);
  });
  await t.test("foreign, missing, and malformed assignments do not change stored slots", async () => {
    const before = await prefs();
    for (const body of [{ nsfwApiKeyId: "foreign-key" }, { studioApiKeyId: "foreign-key" }, { studioApiKeyId: "missing" }, { sfwApiKeyId: "missing" }, { nsfwApiKeyId: 4 }, {}, { nsfwApiKeyId: null, key: "injected" }]) {
      assert.equal((await patch(body)).status, 400);
      assert.deepEqual(await prefs(), before);
    }
  });
  await t.test("an explicit Story profile enables private mode while NSFW changes preserve it", async () => {
    const before = await prefs();
    await db.update(user).set({ preferences: { ...before, preferredProvider: "official" } }).where(eq(user.id, owner));
    assert.equal((await patch({ nsfwApiKeyId: "nsfw-key" })).status, 200);
    assert.equal((await prefs())?.preferredProvider, "official");
    assert.equal((await patch({ sfwApiKeyId: "sfw-key" })).status, 200);
    assert.equal((await prefs())?.preferredProvider, "private");
    await db.update(user).set({ preferences: before }).where(eq(user.id, owner));
  });
  await t.test("SFW and NSFW may share a saved profile", async () => {
    assert.equal((await patch({ sfwApiKeyId: "sfw-key", nsfwApiKeyId: "sfw-key" })).status, 200);
    assert.deepEqual((await read()).data, { sfwApiKeyId: "sfw-key", nsfwApiKeyId: "sfw-key" });
    assert.equal((await prefs())?.studioApiKeyId, undefined);
  });
  await t.test("clearing NSFW keeps SFW configured", async () => {
    assert.equal((await patch({ nsfwApiKeyId: null })).status, 200);
    assert.equal((await prefs())?.activeApiKeyId, "sfw-key");
    assert.equal((await prefs())?.nsfwApiKeyId, null);
    assert.equal((await prefs())?.studioApiKeyId, undefined);
  });
  await t.test("legacy profiles with no active ID are retained and pinned when the second endpoint is assigned", async () => {
    await db.update(user).set({ preferences: { theme: "gold" } }).where(eq(user.id, owner));
    assert.equal((await read()).data.sfwApiKeyId, "nsfw-key");
    assert.equal((await patch({ nsfwApiKeyId: "sfw-key" })).status, 200);
    assert.equal((await prefs())?.activeApiKeyId, "nsfw-key");
  });
  await t.test("unassigned legacy SFW fallback excludes the NSFW slot", async () => {
    await db.update(user).set({ preferences: { nsfwApiKeyId: "nsfw-key", theme: "gold" } }).where(eq(user.id, owner));
    assert.deepEqual((await read()).data, { sfwApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key" });
  });
  await t.test("obsolete Studio preferences are ignored and removed by the next two-slot PATCH", async () => {
    await db.update(user).set({ preferences: { activeApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key", studioApiKeyId: "sfw-key", theme: "gold" } }).where(eq(user.id, owner));
    assert.deepEqual((await read()).data, { sfwApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key" });
    assert.equal((await patch({ nsfwApiKeyId: "sfw-key" })).status, 200);
    assert.equal((await prefs())?.studioApiKeyId, undefined);
    assert.equal((await prefs())?.activeApiKeyId, "sfw-key");
    assert.equal((await prefs())?.nsfwApiKeyId, "sfw-key");
    assert.equal((await prefs())?.theme, "gold");
  });
  await t.test("deleting a assigned profile clears only its references", async () => {
    await patch({ sfwApiKeyId: "sfw-key", nsfwApiKeyId: "nsfw-key" });
    assert.equal((await app.request("/nsfw-key", { method: "DELETE" })).status, 200);
    assert.equal((await prefs())?.activeApiKeyId, "sfw-key");
    assert.equal((await prefs())?.nsfwApiKeyId, null);
    assert.equal((await prefs())?.studioApiKeyId, undefined);
    assert.equal((await prefs())?.theme, "gold");
  });
});
