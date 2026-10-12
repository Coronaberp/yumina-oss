import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { worldRoutes } from "./worlds.js";
import { worldEditLockMiddleware } from "../lib/world-edit-lock.js";
import type { AppEnv } from "../lib/types.js";

test("owner controls persist edit locks without changing authored content", async t => {
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), id = crypto.randomUUID();
  await db.insert(user).values([
    { id: owner, name: "Lock owner", email: `${owner}@example.test` },
    { id: other, name: "Other", email: `${other}@example.test` },
  ]);
  await db.insert(worlds).values({ id, creatorId: owner, name: "Protected card", schema: { name: "Protected card", entries: [] } });
  let actor = owner;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  app.use("/api/*", worldEditLockMiddleware);
  const handler = worldRoutes.routes.filter(r => r.method === "PATCH" && r.path === "/:id/editing-lock").at(-1);
  assert.ok(handler, "Owner lock controls must be registered");
  app.patch("/api/worlds/:id/editing-lock", handler.handler);
  let edits = 0;
  app.patch("/api/worlds/:id", c => { edits++; return c.json({ ok: true }); });
  const read = async () => (await db.select().from(worlds).where(eq(worlds.id, id)))[0]!;
  const before = await read();
  const toggle = (body: unknown) => app.request(`/api/worlds/${id}/editing-lock`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  await t.test("locking blocks writes while retaining the world schema", async () => {
    const response = await toggle({ locked: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id, editingLocked: true } });
    const saved = await read();
    assert.equal(saved.editingLocked, true);
    assert.deepEqual(saved.schema, before.schema);
    assert.equal(saved.name, before.name);
    assert.equal(saved.updatedAt?.toISOString(), before.updatedAt?.toISOString());
    assert.equal((await app.request(`/api/worlds/${id}`, { method: "PATCH" })).status, 403);
    assert.equal(edits, 0);
  });
  await t.test("another user cannot unlock the card", async () => {
    actor = other;
    assert.equal((await toggle({ locked: false })).status, 404);
    assert.equal((await read()).editingLocked, true);
    actor = owner;
  });
  await t.test("malformed controls cannot change the lock", async () => {
    for (const body of [{}, { locked: "false" }, { locked: false, schema: {} }]) {
      assert.equal((await toggle(body)).status, 400);
      assert.equal((await read()).editingLocked, true);
    }
  });
  await t.test("the owner can deliberately unlock and edit again", async () => {
    assert.equal((await toggle({ locked: false })).status, 200);
    assert.equal((await read()).editingLocked, false);
    assert.equal((await app.request(`/api/worlds/${id}`, { method: "PATCH" })).status, 200);
    assert.equal(edits, 1);
  });
});
