import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import * as engine from "@yumina/engine";
import { db } from "../db/index.js";
import * as schemaTables from "../db/schema.js";
import { agentRuns, user, worldPendingEdits, worldReviewSubmissions, worlds, worldSnapshots } from "../db/schema.js";
import * as pendingEdit from "../lib/pending-edit.js";
import * as checkpoint from "../lib/studio-credit-checkpoint.js";
import * as material from "../lib/studio-world-material.js";
import * as summary from "../lib/studio-tools/snapshot-summary.js";
import type { AppEnv } from "../lib/types.js";

after(async () => {
  const client = db.$client;
  if (client instanceof PGlite && !client.closed) await client.close();
});

let userId = "";
function loadRoutes(capture = checkpoint.captureStudioCreditWorldRevision) {
  const file = new URL("./studio.ts", import.meta.url);
  const require = createRequire(file);
  const module = { exports: {} as { studioRoutes: Hono<AppEnv> } };
  const mocks: Record<string, unknown> = {
    "../db/index.js": { db }, "../db/schema.js": schemaTables,
    "@yumina/engine": engine,
    "../lib/pending-edit.js": pendingEdit,
    "../lib/studio-credit-checkpoint.js": { ...checkpoint, captureStudioCreditWorldRevision: capture },
    "../lib/studio-world-material.js": material,
    "../lib/studio-tools/snapshot-summary.js": summary,
    "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => {
      c.set("user", { id: userId } as AppEnv["Variables"]["user"]); await next();
    } },
  };
  new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)(
    (id: string) => mocks[id] ?? (id.startsWith("../") ? {} : require(id)), module, module.exports,
  );
  return module.exports.studioRoutes;
}
const routes = loadRoutes();
const oldCover = "@asset:11111111-1111-4111-8111-111111111111";
const newCover = "@asset:22222222-2222-4222-8222-222222222222";
const banner = "@asset:33333333-3333-4333-8333-333333333333";

async function fixture(status: "draft" | "published" = "draft") {
  const owner = crypto.randomUUID(), worldId = crypto.randomUUID();
  const schema = { id: worldId, version: "21.0.0", name: "Rollback art", entries: [], variables: [], rules: [],
    bannerImageUrl: banner, bannerCrop: { x: 7, y: 8, zoom: 1, fit: "contain" },
    coverCrop: { x: 2, y: 3, zoom: 1.25 }, customData: { untouched: ["full", 7] } };
  await db.insert(user).values({ id: owner, name: "Rollback owner", email: `${owner}@test.invalid` });
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: schema.name,
    status, isPublished: status === "published", schema, thumbnailUrl: newCover });
  userId = owner;
  const read = async () => (await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!;
  const pending = async () => (await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId)))[0];
  const backups = async () => db.select().from(worldSnapshots).where(and(eq(worldSnapshots.worldId, worldId), eq(worldSnapshots.label, "Before rollback")));
  const snapshot = async (schemaData: Record<string, unknown>, options: { runId?: string; label?: string; createdAt?: Date } = {}) => {
    const [row] = await db.insert(worldSnapshots).values({ worldId, userId: owner, schemaData,
      agentRunId: options.runId, label: options.label ?? "Art checkpoint", createdAt: options.createdAt ?? new Date() }).returning();
    return row!;
  };
  const rollback = (snapshotId: string) => routes.request(`/${worldId}/rollback/${snapshotId}`, { method: "POST" });
  return { owner, worldId, schema, read, pending, backups, snapshot, rollback };
}

test("cover-only rollback restores the portrait and keeps a complete reversible backup", async () => {
  const f = await fixture();
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, oldCover));
  assert.equal((await f.rollback(target.id)).status, 200);
  assert.equal((await f.read()).thumbnailUrl, oldCover);
  assert.deepEqual((await f.read()).schema, f.schema, "snapshot bookkeeping must never replace the custom schema");
  const backups = await f.backups();
  assert.equal(backups.length, 1, "portrait-only changes need a rollback backup");
  assert.deepEqual(material.decodeStudioSnapshotMaterial(backups[0]!.schemaData), { schema: f.schema, thumbnailUrl: newCover });
  assert.equal((await f.rollback(backups[0]!.id)).status, 200);
  assert.equal((await f.read()).thumbnailUrl, newCover);
  assert.deepEqual((await f.read()).schema, f.schema);
  const redo = await f.backups();
  assert.equal(redo.length, 1);
  assert.deepEqual(material.decodeStudioSnapshotMaterial(redo[0]!.schemaData), { schema: f.schema, thumbnailUrl: oldCover });
});

test("tracked null clears a portrait and re-undo restores its previous reference", async () => {
  const f = await fixture();
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, null));
  assert.equal((await f.rollback(target.id)).status, 200);
  assert.equal((await f.read()).thumbnailUrl, null);
  assert.deepEqual((await f.read()).schema, f.schema);
  const [backup] = await f.backups();
  assert.equal((await f.rollback(backup!.id)).status, 200);
  assert.equal((await f.read()).thumbnailUrl, newCover);
});

test("legacy schema-only snapshots preserve the current portrait and back up full material", async () => {
  const f = await fixture();
  const targetSchema = { ...f.schema, bannerImageUrl: "", coverCrop: { x: 0, y: 0, zoom: 1 } };
  const target = await f.snapshot(targetSchema);
  assert.equal((await f.rollback(target.id)).status, 200);
  assert.equal((await f.read()).thumbnailUrl, newCover);
  assert.deepEqual((await f.read()).schema, targetSchema);
  const [backup] = await f.backups();
  assert.deepEqual(material.decodeStudioSnapshotMaterial(backup!.schemaData), { schema: f.schema, thumbnailUrl: newCover });
});

test("published rollback uses held schema and portrait without publishing pending material", async () => {
  const f = await fixture("published");
  const workingSchema = { ...f.schema, bannerImageUrl: "", customData: { untouched: ["held", 9] } };
  await pendingEdit.writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: workingSchema, thumbnailUrl: null });
  await db.update(worldPendingEdits).set({ status: "pending" }).where(eq(worldPendingEdits.worldId, f.worldId));
  await db.insert(worldReviewSubmissions).values({ worldId: f.worldId, groupKey: f.worldId, submittedBy: f.owner, decision: "pending", submissionType: "edit" });
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(workingSchema, oldCover));
  const response = await f.rollback(target.id);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { held: boolean }).held, true);
  assert.equal((await f.read()).thumbnailUrl, newCover, "live cover stays approved");
  assert.deepEqual((await f.read()).schema, f.schema);
  assert.equal((await f.pending())!.thumbnailUrl, oldCover);
  assert.deepEqual((await f.pending())!.schema, workingSchema);
  assert.equal((await f.pending())!.status, "draft");
  const [submission] = await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.worldId, f.worldId));
  assert.equal(submission!.decision, "withdrawn");
  const [backup] = await f.backups();
  assert.deepEqual(material.decodeStudioSnapshotMaterial(backup!.schemaData), { schema: workingSchema, thumbnailUrl: null });
  assert.equal((await f.rollback(backup!.id)).status, 200);
  assert.equal((await f.pending())!.thumbnailUrl, null, "re-undo retains a held explicit clear");
  assert.deepEqual((await f.pending())!.schema, workingSchema);
  const legacy = await f.snapshot({ ...workingSchema, bannerImageUrl: banner });
  assert.equal((await f.rollback(legacy.id)).status, 200);
  assert.equal((await f.pending())!.thumbnailUrl, null, "legacy rollback preserves the working clear");
});

test("timeline and detailed diffs include portrait-only edits against current working material", async () => {
  const f = await fixture("published");
  await pendingEdit.writeStudioWorldSchema({ worldId: f.worldId, creatorId: f.owner, schema: f.schema, thumbnailUrl: oldCover });
  const legacy = await f.snapshot(f.schema, { createdAt: new Date(1000) });
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, newCover), { createdAt: new Date(2000) });
  const listResponse = await routes.request(`/${f.worldId}/snapshots`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as { data: Array<{ id: string; summary: Array<{ id: string }> }> };
  assert.deepEqual(list.data.find(row => row.id === legacy.id)!.summary, [], "legacy snapshots do not invent a historical cover");
  const chips = list.data.find(row => row.id === target.id)!.summary;
  assert.deepEqual(chips.map(change => change.id), ["thumbnailUrl"], "only the working portrait changed");
  for (const against of ["auto", "current"]) {
    const response = await routes.request(`/${f.worldId}/snapshots/${target.id}/diff?against=${against}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { changes: Array<{ id: string; fields: unknown[] }> } };
    assert.deepEqual(body.data.changes.map(change => change.id), ["thumbnailUrl"]);
    assert.deepEqual(body.data.changes[0]!.fields, [{ field: "thumbnailUrl", before: newCover, after: oldCover }]);
  }
});

test("snapshot schema responses unwrap tracked material and preserve owner-only access", async () => {
  const f = await fixture();
  const [run] = await db.insert(agentRuns).values({ worldId: f.worldId, userId: f.owner, model: "test", status: "completed", context: { studioAppliedChanges: true } }).returning();
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, oldCover), { runId: run!.id });
  const url = `/${f.worldId}/snapshots?agentRunId=${run!.id}&includeSchema=true`;
  const response = await routes.request(url);
  const body = await response.json() as { data: Array<{ schemaData: unknown; thumbnailUrl?: string | null }> };
  assert.equal(response.status, 200);
  assert.deepEqual(body.data[0]!.schemaData, f.schema);
  assert.equal(body.data[0]!.thumbnailUrl, oldCover);
  const before = await f.read();
  userId = "foreign-owner";
  assert.equal((await routes.request(url)).status, 404);
  assert.equal((await routes.request(`/${f.worldId}/snapshots/${target.id}/diff`)).status, 404);
  assert.equal((await f.rollback(target.id)).status, 404);
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(await f.backups(), []);
});

test("a material no-op retains the existing reversible backup", async () => {
  const f = await fixture();
  const backup = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, oldCover), { label: "Before rollback" });
  const target = await f.snapshot(material.encodeStudioSnapshotMaterial(f.schema, newCover));
  assert.equal((await f.rollback(target.id)).status, 200);
  assert.deepEqual((await f.read()).schema, f.schema);
  assert.deepEqual((await f.backups()).map(row => row.id), [backup.id]);
});
