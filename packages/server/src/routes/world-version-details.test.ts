import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, worldVersions, worldPendingEdits } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { worldVersionRoutes } from "./world-versions.js";

after(async () => { if (db.$client instanceof PGlite && !db.$client.closed) await db.$client.close(); });

test("selected version details stay owner-only, include the working rating, and never write", async () => {
  const owner = crypto.randomUUID(); const stranger = crypto.randomUUID();
  const worldId = crypto.randomUUID(); const versionId = crypto.randomUUID();
  await db.insert(user).values([{ id: owner, name: "Owner", email: `${owner}@test.invalid` }, { id: stranger, name: "Other", email: `${stranger}@test.invalid` }]);
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: "Story", schema: { name: "Current" }, status: "published", ageRating: "adult" });
  await db.insert(worldVersions).values({ id: versionId, worldId, createdBy: owner, name: "Snapshot", schema: { privateCustom: { source: "<script>do not execute</script>" } }, thumbnailUrl: "@asset:cover", ageRating: "adult" });
  await db.insert(worldPendingEdits).values({ worldId, createdBy: owner, groupKey: worldId, schema: { name: "Working copy" }, ageRating: "all" });
  let actor = owner;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  const route = worldVersionRoutes.routes.filter(r => r.method === "GET" && r.path === "/:id/versions/:versionId").at(-1);
  assert.ok(route);
  app.get("/:id/versions/:versionId", route.handler);
  const beforeWorld = await db.select().from(worlds).where(eq(worlds.id, worldId));
  const beforeVersions = await db.select().from(worldVersions);
  const beforePending = await db.select().from(worldPendingEdits);
  const response = await app.request(`/${worldId}/versions/${versionId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json() as { currentAgeRating: string; data: { ageRating: string; thumbnailUrl: string | null; schema: unknown } };
  assert.equal(body.currentAgeRating, "all"); assert.equal(body.data.ageRating, "adult"); assert.equal(body.data.thumbnailUrl, "@asset:cover");
  assert.deepEqual(body.data.schema, beforeVersions[0]!.schema);
  actor = stranger;
  const denied = await app.request(`/${worldId}/versions/${versionId}`);
  assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: "Version not found" });
  actor = owner;
  assert.equal((await app.request(`/another-world/versions/${versionId}`)).status, 404);
  assert.deepEqual(await db.select().from(worlds).where(eq(worlds.id, worldId)), beforeWorld);
  assert.deepEqual(await db.select().from(worldVersions), beforeVersions);
  assert.deepEqual(await db.select().from(worldPendingEdits), beforePending);
  // Non-published worlds use their own rating even with a historical pending row.
  await db.update(worlds).set({ status: "draft" }).where(eq(worlds.id, worldId));
  const draftBody = await (await app.request(`/${worldId}/versions/${versionId}`)).json() as { currentAgeRating: string };
  assert.equal(draftBody.currentAgeRating, "adult");
});
