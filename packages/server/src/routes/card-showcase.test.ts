import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../lib/types.js";

process.env.YUMINA_EDITION = "local";
await import("../test/database-fixture.js");
const { db } = await import("../db/index.js");
const { user, worlds } = await import("../db/schema.js");
const { worldRoutes } = await import("./worlds.js");

test("saved public card showcases are bounded and previewed without exposing the story schema", async t => {
  const owner = crypto.randomUUID(), worldId = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Card owner", email: `${owner}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: "Card profile", description: "Public introduction", status: "published", isPublished: true, ageRating: "all", schema: {
    id: worldId, name: "Card profile", version: "21.0.0", entries: [{ id: "hidden", content: "PRIVATE LORE" }],
    rootComponent: { files: { "character-showcase.ts": "PRIVATE POPUP SETTINGS" } },
    cardShowcase: { html: "<h2>Public card profile</h2>", css: "h2 {color:gold;}" },
  } });
  t.after(async () => {
    await db.delete(worlds).where(eq(worlds.id, worldId));
    await db.delete(user).where(eq(user.id, owner));
    assert.equal((await db.select({ id: user.id }).from(user).where(eq(user.id, owner))).length, 0, "The isolated QA account is removed");
    assert.equal((await db.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, worldId))).length, 0, "The isolated QA card is removed");
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); });
  for (const [method, path] of [["GET", "/:id"], ["PATCH", "/:id"], ["POST", "/"]] as const) {
    const handler = worldRoutes.routes.filter(route => route.method === method && route.path === path).at(-1)!.handler;
    app.on(method, path, handler);
  }
  await t.test("the public preview returns showcase display content without game schema or private lore", async () => {
    const response = await app.request(`/${worldId}?preview=true`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Record<string, unknown> };
    assert.deepEqual(body.data.cardShowcase, { html: "<h2>Public card profile</h2>", css: "h2 {color:gold;}" });
    assert.equal(body.data.schema, undefined);
    assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  });
  await t.test("create and update reject oversized or malformed showcase values atomically", async () => {
    const before = (await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId)))[0]!.schema;
    for (const cardShowcase of [{ html: "x".repeat(100001), css: "" }, { html: "", css: "x".repeat(30001) }, { html: 42, css: "" }, { css: "", characters: { hidden: "style" } }]) {
      for (const method of ["POST", "PATCH"]) {
        const response = await app.request(method === "POST" ? "/" : `/${worldId}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rejected profile", schema: { cardShowcase } }) });
        assert.equal(response.status, 400, await response.text());
      }
    }
    assert.deepEqual((await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId)))[0]!.schema, before);
  });
});
