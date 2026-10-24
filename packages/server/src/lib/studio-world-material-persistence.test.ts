import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, user, worldPendingEdits, worlds } from "../db/schema.js";
import { writeStudioWorldSchema } from "./pending-edit.js";
import { writeScopedStudioWorldSchema } from "./studio-run-scope.js";
import { captureStudioCreditWorldRevision } from "./studio-credit-checkpoint.js";

after(async () => { if (db.$client instanceof PGlite && !db.$client.closed) await db.$client.close(); });
const oldCover = "@asset:11111111-1111-4111-8111-111111111111";
const newCover = "@asset:22222222-2222-4222-8222-222222222222";
const banner = "@asset:33333333-3333-4333-8333-333333333333";
async function fixture(status: "draft" | "published" = "draft") {
  const owner = crypto.randomUUID(), worldId = crypto.randomUUID();
  const schema = { id: worldId, version: "21.0.0", name: "Art fixture", entries: [], variables: [], rules: [],
    bannerImageUrl: banner, bannerCrop: { x: 3, y: 4, zoom: 1, fit: "contain" },
    coverCrop: { x: 0, y: 0, zoom: 1 }, customData: { untouched: ["yes", 7] } };
  await db.insert(user).values({ id: owner, email: `${owner}@test.invalid`, name: "Art fixture" });
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: schema.name, schema, thumbnailUrl: oldCover, status, isPublished: status === "published" });
  return { owner, worldId, schema,
    read: async () => (await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!,
    pending: async () => (await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId)))[0],
  };
}

test("draft portraits persist independently, survive schema-only writes, and explicitly clear", async () => {
  const f = await fixture();
  const schema = { ...f.schema, coverCrop: { x: 8, y: 0, zoom: 1.5 } };
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema, expectedSchema: f.schema, thumbnailUrl: newCover, expectedThumbnailUrl: oldCover });
  assert.equal((await f.read()).thumbnailUrl, newCover); assert.deepEqual((await f.read()).schema, schema);
  const renamed = { ...schema, name: "Renamed" };
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: renamed, expectedSchema: schema });
  assert.equal((await f.read()).thumbnailUrl, newCover);
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: renamed, thumbnailUrl: null, expectedThumbnailUrl: newCover });
  const result = await f.read(); assert.equal(result.thumbnailUrl, null);
  assert.deepEqual(result.schema, renamed); assert.equal((result.schema as typeof renamed).bannerImageUrl, banner);
});

test("published portrait changes are held and held null survives a later banner-only write", async () => {
  const f = await fixture("published");
  const saved = await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: newCover, expectedThumbnailUrl: oldCover });
  assert.equal(saved.held, true); assert.deepEqual(saved.reasons, ["cover"]);
  assert.equal((await f.read()).thumbnailUrl, oldCover); assert.equal((await f.pending())?.thumbnailUrl, newCover);
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: null, expectedThumbnailUrl: newCover });
  const schema = { ...f.schema, bannerImageUrl: "", bannerCrop: { x: 0, y: 0, zoom: 1, fit: "contain" } };
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema, expectedSchema: f.schema });
  assert.equal((await f.pending())?.thumbnailUrl, null); assert.deepEqual((await f.pending())?.schema, schema);
  assert.equal((await f.read()).thumbnailUrl, oldCover); assert.deepEqual((await f.read()).schema, f.schema);
});

test("same-schema portrait races fail before changing any world data", async () => {
  const f = await fixture();
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: newCover, expectedThumbnailUrl: oldCover });
  const before = await f.read();
  await assert.rejects(writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: null, expectedThumbnailUrl: oldCover }), /STALE_STUDIO_WORLD_SCHEMA/);
  assert.deepEqual(await f.read(), before);
});

test("scoped portrait writes retain ownership and stopped-worker fencing", async () => {
  const f = await fixture();
  const [run] = await db.insert(agentRuns).values({ worldId: f.worldId, userId: f.owner, model: "fixture", status: "running", messages: [] }).returning();
  const scope = { worldId: f.worldId, userId: f.owner, runId: run!.id, schema: f.schema, expectedSchema: f.schema };
  await writeScopedStudioWorldSchema({ ...scope, thumbnailUrl: null, expectedThumbnailUrl: oldCover });
  assert.equal((await f.read()).thumbnailUrl, null);
  await writeScopedStudioWorldSchema({ ...scope, thumbnailUrl: newCover, expectedThumbnailUrl: null });
  await db.update(agentRuns).set({ status: "error" }).where(eq(agentRuns.id, run!.id));
  await assert.rejects(writeScopedStudioWorldSchema({ ...scope, thumbnailUrl: oldCover, expectedThumbnailUrl: newCover }), /STUDIO_RUN_NO_LONGER_ACTIVE/);
  await assert.rejects(writeScopedStudioWorldSchema({ ...scope, userId: crypto.randomUUID(), thumbnailUrl: oldCover }), /World not found/);
  assert.equal((await f.read()).thumbnailUrl, newCover);
});

test("caller rollback restores portrait and schema atomically, including held edits", async () => {
  const f = await fixture("published"), before = await f.read();
  await assert.rejects(db.transaction(async tx => {
    await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: { ...f.schema, bannerImageUrl: "" }, thumbnailUrl: newCover, database: tx });
    throw new Error("Abort fixture transaction");
  }), /Abort fixture transaction/);
  assert.deepEqual(await f.read(), before); assert.equal(await f.pending(), undefined);
});

test("credit captures expose raw live and held portraits without changing legacy revision digests", async () => {
  const f = await fixture("published"), scope = { worldId: f.worldId, userId: f.owner };
  const first = await captureStudioCreditWorldRevision(scope); assert.equal(first.thumbnailUrl, oldCover);
  await db.update(worlds).set({ thumbnailUrl: newCover }).where(eq(worlds.id, f.worldId));
  const changed = await captureStudioCreditWorldRevision(scope);
  assert.equal(changed.thumbnailUrl, newCover); assert.equal(changed.revision, first.revision);
  await writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: null, expectedThumbnailUrl: newCover });
  const cleared = await captureStudioCreditWorldRevision(scope); assert.equal(cleared.thumbnailUrl, null);
  await db.update(worldPendingEdits).set({ thumbnailUrl: oldCover }).where(eq(worldPendingEdits.worldId, f.worldId));
  const pendingChanged = await captureStudioCreditWorldRevision(scope);
  assert.equal(pendingChanged.thumbnailUrl, oldCover); assert.equal(pendingChanged.revision, cleared.revision); assert.deepEqual(pendingChanged.schema, cleared.schema);
});
