import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, user, worldPendingEdits, worlds } from "../db/schema.js";
import { writeStudioWorldSchema } from "./pending-edit.js";
import { captureStudioCreditWorldRevision, claimStudioCreditResume, readStudioCreditCheckpoint,
  stageStudioCreditIteration, withStudioCreditClaimTransaction, type StudioCreditCheckpoint } from "./studio-credit-checkpoint.js";

after(async () => { if (db.$client instanceof PGlite && !db.$client.closed) await db.$client.close(); });
const original = "@asset:11111111-1111-4111-8111-111111111111";
const replacement = "@asset:22222222-2222-4222-8222-222222222222";
function checkpoint(revision: string, sourceThumbnailUrl?: string | null, settled = true): StudioCreditCheckpoint {
  return { version: 1, phase: "generated", messages: [], iteration: 0, worldRevision: revision, requiredCredits: 1,
    ...(sourceThumbnailUrl !== undefined ? { sourceThumbnailUrl } : {}),
    generated: { textContent: "Ready", toolCalls: [], cost: 1, usageLogId: "fixture-usage-only", settled } };
}
async function fixture(status: "draft" | "published" = "draft", heldNull = false) {
  const userId = crypto.randomUUID(), worldId = crypto.randomUUID();
  const schema = { id: worldId, name: "Thumbnail guard", entries: [], variables: [], rules: [] };
  const updatedAt = new Date("2026-10-23T00:00:00Z");
  await db.insert(user).values({ id: userId, email: `${userId}@test.invalid`, name: "Thumbnail guard" });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: schema.name, schema, thumbnailUrl: original, status, isPublished: status === "published", updatedAt });
  if (heldNull) await db.insert(worldPendingEdits).values({ worldId, createdBy: userId, groupKey: worldId, schema, thumbnailUrl: null, ageRating: "all", reasons: ["cover"], updatedAt });
  const snapshot = await captureStudioCreditWorldRevision({ worldId, userId });
  const [run] = await db.insert(agentRuns).values({ worldId, userId, status: "running", model: "fixture", messages: [] }).returning();
  return { scope: { worldId, userId, runId: run!.id }, schema, snapshot,
    readRun: async () => (await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!,
  };
}

test("checkpoint validator accepts missing, null, and string portrait sources only", () => {
  for (const source of [undefined, null, original]) assert.ok(readStudioCreditCheckpoint(checkpoint("revision", source)));
  for (const sourceThumbnailUrl of [1, false, [], {}]) assert.equal(readStudioCreditCheckpoint({ ...checkpoint("revision"), sourceThumbnailUrl }), null);
});

test("staging captures the pre-generation portrait and rejects a same-timestamp portrait change", async () => {
  const f = await fixture();
  const staged = await stageStudioCreditIteration(f.scope, checkpoint(f.snapshot.revision), undefined, { sourceThumbnailUrl: original, staleWorld: "reject" });
  assert.equal(staged.ok, true); if (!staged.ok) assert.fail("Expected staged credit claim");
  assert.equal(staged.checkpoint.sourceThumbnailUrl, original); assert.equal(staged.workingThumbnailUrl, original);
  await db.update(worlds).set({ thumbnailUrl: replacement }).where(eq(worlds.id, f.scope.worldId));
  assert.equal((await captureStudioCreditWorldRevision(f.scope)).revision, f.snapshot.revision);
  assert.deepEqual(await stageStudioCreditIteration(f.scope, checkpoint(f.snapshot.revision), staged.claimId, { sourceThumbnailUrl: original, staleWorld: "reject" }), { ok: false, code: "STALE_WORLD" });
});

test("paid portrait-guarded paused results reject same-timestamp edits without losing generated work", async () => {
  const f = await fixture(), saved = checkpoint(f.snapshot.revision, original);
  await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: saved as unknown as Record<string, unknown> }).where(eq(agentRuns.id, f.scope.runId));
  await db.update(worlds).set({ thumbnailUrl: replacement }).where(eq(worlds.id, f.scope.worldId));
  assert.deepEqual(await claimStudioCreditResume(f.scope), { ok: false, code: "STALE_WORLD" });
  const retained = readStudioCreditCheckpoint((await f.readRun()).creditCheckpoint);
  assert.deepEqual(retained?.phase === "generated" && retained.generated, saved.generated);
  assert.equal(retained?.sourceThumbnailUrl, original);
});

test("legacy paid paused results preserve their existing revision compatibility", async () => {
  const f = await fixture(), saved = checkpoint(f.snapshot.revision);
  await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: saved as unknown as Record<string, unknown> }).where(eq(agentRuns.id, f.scope.runId));
  await db.update(worlds).set({ thumbnailUrl: replacement }).where(eq(worlds.id, f.scope.worldId));
  const resumed = await claimStudioCreditResume(f.scope);
  assert.equal(resumed.ok, true); if (!resumed.ok) assert.fail("Expected resumed credit claim");
  assert.equal(resumed.rebased, false); assert.equal(Object.hasOwn(resumed.checkpoint, "sourceThumbnailUrl"), false);
  assert.equal(resumed.checkpoint.phase, "generated");
  if (resumed.checkpoint.phase === "generated") assert.equal(resumed.checkpoint.generated.cost, 1);
});

test("live null and held null portrait guards are enforced before claimed work runs", async () => {
  for (const status of ["draft", "published"] as const) {
    const f = await fixture(status, status === "published");
    if (status === "draft") await db.update(worlds).set({ thumbnailUrl: null }).where(eq(worlds.id, f.scope.worldId));
    const snapshot = await captureStudioCreditWorldRevision(f.scope);
    assert.equal(snapshot.thumbnailUrl, null);
    await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: checkpoint(snapshot.revision, null) as unknown as Record<string, unknown> }).where(eq(agentRuns.id, f.scope.runId));
    const resumed = await claimStudioCreditResume(f.scope);
    assert.equal(resumed.ok, true); if (!resumed.ok) assert.fail("Expected resumed credit claim");
    assert.equal(resumed.checkpoint.sourceThumbnailUrl, null);
    if (status === "published") await db.update(worldPendingEdits).set({ thumbnailUrl: replacement }).where(eq(worldPendingEdits.worldId, f.scope.worldId));
    else await db.update(worlds).set({ thumbnailUrl: replacement }).where(eq(worlds.id, f.scope.worldId));
    let entered = false;
    await assert.rejects(withStudioCreditClaimTransaction(f.scope, resumed.claimId, async () => { entered = true; return { value: null, checkpoint: null }; }), { code: "STALE_WORLD" });
    assert.equal(entered, false);
  }
});

test("unpaid stale guarded results rebase to the current portrait without retaining generated work", async () => {
  const f = await fixture();
  await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: checkpoint(f.snapshot.revision, original, false) as unknown as Record<string, unknown> }).where(eq(agentRuns.id, f.scope.runId));
  await db.update(worlds).set({ thumbnailUrl: replacement }).where(eq(worlds.id, f.scope.worldId));
  const resumed = await claimStudioCreditResume(f.scope);
  assert.equal(resumed.ok, true); if (!resumed.ok) assert.fail("Expected resumed credit claim");
  assert.equal(resumed.rebased, true); assert.equal(resumed.checkpoint.phase, "preflight");
  assert.equal(resumed.checkpoint.sourceThumbnailUrl, replacement); assert.equal(Object.hasOwn(resumed.checkpoint, "generated"), false);
});

test("a claimed batch refreshes its own portrait guard after every successful write", async () => {
  const f = await fixture("published");
  const staged = await stageStudioCreditIteration(f.scope, checkpoint(f.snapshot.revision, original));
  assert.equal(staged.ok, true); if (!staged.ok) assert.fail("Expected staged credit claim");
  const first = await withStudioCreditClaimTransaction(f.scope, staged.claimId, async (tx, current) => {
    await writeStudioWorldSchema({ worldId: f.scope.worldId, creatorId: f.scope.userId, schema: f.schema, thumbnailUrl: replacement, expectedThumbnailUrl: original, database: tx });
    return { value: "first", checkpoint: current };
  });
  assert.equal(first.checkpoint?.sourceThumbnailUrl, replacement);
  const second = await withStudioCreditClaimTransaction(f.scope, staged.claimId, async (tx, current) => {
    await writeStudioWorldSchema({ worldId: f.scope.worldId, creatorId: f.scope.userId, schema: f.schema, thumbnailUrl: null, expectedThumbnailUrl: replacement, database: tx });
    return { value: "second", checkpoint: current };
  });
  assert.equal(second.checkpoint?.sourceThumbnailUrl, null);
  const third = await withStudioCreditClaimTransaction(f.scope, staged.claimId, async (_tx, current) => ({ value: "third", checkpoint: current }));
  assert.equal(third.value, "third"); assert.equal(third.checkpoint?.sourceThumbnailUrl, null);
});
