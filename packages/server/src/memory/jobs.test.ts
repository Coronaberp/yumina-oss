import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryDatabase } from "./database.js";
import { MemoryJobs } from "./jobs.js";

test("expired worker claims cannot commit and tombstones fence all later writes", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  let now = 1000;
  try {
    const jobs = new MemoryJobs(db, () => now);
    await jobs.initialize();
    await jobs.syncEpoch("profile", "session", 2);
    await jobs.enqueue({
      profileId: "profile",
      sessionId: "session",
      epoch: 2,
      sourceHash: "a",
      kind: "extract",
      payload: {},
    });
    const first = await jobs.claim(10);
    assert.ok(first);
    now += 11;
    const second = await jobs.claim(10);
    assert.ok(second);
    assert.notEqual(first.token, second.token);
    assert.equal(await jobs.finish(first), false);
    assert.equal(await jobs.finish(second), true);
    await jobs.syncEpoch("profile", "session", 3, true);
    assert.equal(await jobs.isCurrent("profile", "session", 3), false);
    assert.equal(await jobs.syncEpoch("profile", "session", 4), false);
  } finally {
    await db.close();
  }
});
test("enqueue is idempotent and a failure requires an explicit retry", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    const jobs = new MemoryJobs(db);
    await jobs.initialize();
    await jobs.syncEpoch("p", "s", 1);
    const input = {
      profileId: "p",
      sessionId: "s",
      epoch: 1,
      sourceHash: "h",
      kind: "extract",
      payload: {},
    };
    assert.equal(await jobs.enqueue(input), await jobs.enqueue(input));
    const claim = await jobs.claim();
    assert.ok(claim);
    await jobs.fail(claim, "embedding_failed");
    assert.equal(await jobs.claim(), null);
    await jobs.retry("p", "s");
    assert.ok(await jobs.claim());
  } finally {
    await db.close();
  }
});

test("different jobs share one durable session claim", async () => {
  const db = await createMemoryDatabase();
  try {
    const jobs = new MemoryJobs(db);
    await jobs.initialize();
    await jobs.syncEpoch("p", "s", 1);
    for (const kind of ["extract", "rebuild"])
      await jobs.enqueue({
        profileId: "p",
        sessionId: "s",
        epoch: 1,
        sourceHash: kind,
        kind,
        payload: {},
      });
    const claims = await Promise.all([jobs.claim(), jobs.claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(
      (
        await db.query(
          `SELECT COUNT(*)::int AS count FROM memory_jobs WHERE status='processing'`,
        )
      ).rows[0]?.count,
      1,
    );
  } finally {
    await db.close();
  }
});
test("epoch change cancels obsolete claims immediately and frees the session for new work", async () => {
  const db = await createMemoryDatabase();
  try {
    const jobs = new MemoryJobs(db, () => 1000);
    await jobs.initialize();
    await jobs.syncEpoch("p", "s", 1);
    await jobs.enqueue({
      profileId: "p",
      sessionId: "s",
      epoch: 1,
      sourceHash: "old",
      kind: "extract",
      payload: {},
    });
    const old = await jobs.claim();
    assert.ok(old);
    await jobs.syncEpoch("p", "s", 2);
    const rows = await db.query(
      `SELECT status,token FROM memory_jobs WHERE id=$1`,
      [old.id],
    );
    assert.equal(rows.rows[0]!.status, "cancelled");
    assert.equal(rows.rows[0]!.token, null);
    await jobs.enqueue({
      profileId: "p",
      sessionId: "s",
      epoch: 2,
      sourceHash: "new",
      kind: "extract",
      payload: {},
    });
    const next = await jobs.claim();
    assert.ok(next);
    assert.equal(next.epoch, 2);
    await assert.rejects(
      () => db.transaction((tx) => jobs.assertClaim(tx, old)),
      /stale_claim/,
    );
    assert.equal(await jobs.finish(old), false);
    await jobs.syncEpoch("p", "s", 1);
    assert.equal(await jobs.isCurrent("p", "s", 2), true);
    assert.equal(await jobs.heartbeat(next), true);
  } finally {
    await db.close();
  }
});
