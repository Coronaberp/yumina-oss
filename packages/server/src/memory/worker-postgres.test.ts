import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryDatabase } from "./database.js";
import { MemoryJobs } from "./jobs.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
  quoteSchema,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { reindexProfile } from "./profile-reindex.js";
// Opt-in suite for a disposable loopback PostgreSQL fixture, never DATABASE_URL.
const url = process.env.MEMORY_FENCE_TEST_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/memory_fence")
    throw new Error("Use only the disposable memory_fence fixture");
}
test(
  "PostgreSQL nested savepoints preserve outer rollback",
  { skip: !url },
  async () => {
    const db = await createMemoryDatabase({ url });
    const table = `savepoint_${randomUUID().replaceAll("-", "")}`;
    try {
      await db.query(`CREATE TABLE ${table}(value integer)`);
      await assert.rejects(() =>
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} VALUES(1)`);
          await assert.rejects(() =>
            tx.transaction(async (nested) => {
              await nested.query(`INSERT INTO ${table} VALUES(2)`);
              throw new Error("inner");
            }),
          );
          assert.deepEqual(
            (await tx.query(`SELECT value FROM ${table}`)).rows,
            [{ value: 1 }],
          );
          await tx.transaction(async (nested) => {
            await nested.query(`INSERT INTO ${table} VALUES(3)`);
          });
          throw new Error("outer");
        }),
      );
      assert.deepEqual((await db.query(`SELECT value FROM ${table}`)).rows, []);
    } finally {
      await db.query(`DROP TABLE ${table}`);
      await db.close();
    }
  },
);
test(
  "independent PostgreSQL pools serialize different jobs in the same session",
  { skip: !url },
  async () => {
    const a = await createMemoryDatabase({ url }),
      b = await createMemoryDatabase({ url });
    try {
      const one = new MemoryJobs(a, () => 1000),
        two = new MemoryJobs(b, () => 1000);
      await one.initialize();
      for (let i = 0; i < 20; i++) {
        const session = randomUUID();
        await one.syncEpoch("postgres", session, 1);
        for (const kind of ["extract", "rebuild"])
          await one.enqueue({
            profileId: "postgres",
            sessionId: session,
            epoch: 1,
            sourceHash: kind,
            kind,
            payload: {},
          });
        const results = await Promise.all([one.claim(100), two.claim(100)]);
        assert.equal(results.filter(Boolean).length, 1);
        const claim = results.find(Boolean)!;
        assert.equal(
          (
            await a.query(
              `SELECT COUNT(*)::int AS count FROM memory_jobs WHERE profile_id=$1 AND session_id=$2 AND status='processing'`,
              ["postgres", session],
            )
          ).rows[0]!.count,
          1,
        );
        await one.syncEpoch("postgres", session, 2);
        assert.equal(await two.finish(claim), false);
        await one.enqueue({
          profileId: "postgres",
          sessionId: session,
          epoch: 2,
          sourceHash: "new",
          kind: "extract",
          payload: {},
        });
        const next = await two.claim(100);
        assert.ok(next);
        assert.equal(next.epoch, 2);
        await one.syncEpoch("postgres", session, 3, true);
      }
    } finally {
      await a.close();
      await b.close();
    }
  },
);
test(
  "PostgreSQL recovered reindex rejects old output without changing active readiness",
  { skip: !url },
  async () => {
    const db = await createMemoryDatabase({ url });
    let release!: () => void, entered!: () => void;
    try {
      await ensureRegistry(db);
      const profiles = new ProfileRepository(db, {
        encrypt: (s) => s,
        decrypt: (s) => s,
      });
      const owner = randomUUID(),
        source = await profiles.create(owner, {
          baseUrl: "http://localhost",
          model: "a",
          dimensions: 2,
        }),
        target = await profiles.create(owner, {
          baseUrl: "http://localhost",
          model: "b",
          dimensions: 3,
        });
      for (const p of [source, target]) await ensureProfileSchema(db, p);
      await ensureIdentity(db, {
        profileId: source.id,
        schemaName: source.schemaName,
        ownerUserId: owner,
        sessionId: "s",
        charId: "c",
      });
      await db.query(
        `INSERT INTO ${quoteSchema(source.schemaName)}.memory_facts(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,last_turn,created_ts) VALUES('f','s','c','Text','event','{}',3,0,0,1,1,1)`,
      );
      await profiles.setStatus(owner, source.id, "ready");
      await profiles.activate(owner, source.id, source.revision);
      const blocked = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      let now = 1000;
      const options = {
        db,
        profiles,
        ownerUserId: owner,
        source,
        target,
        key: new Uint8Array(32).fill(3),
        clock: () => now,
      };
      const old = reindexProfile({
        ...options,
        leaseMs: 10,
        heartbeatMs: 60000,
        embedding: {
          embed: async () => {
            entered();
            await blocked;
            return [1, 0, 0];
          },
          embedQuery: async () => [],
        },
      }).then(
        () => null,
        (e) => e.message,
      );
      await started;
      now = 1011;
      await reindexProfile({
        ...options,
        leaseMs: 100,
        embedding: { embed: async () => [1, 0, 0], embedQuery: async () => [] },
      });
      release();
      assert.match(await old, /profile_changed|stale/);
      const active = await profiles.getActive(owner);
      assert.equal(active!.id, target.id);
      assert.equal(active!.status, "ready");
    } finally {
      release?.();
      await db.close();
    }
  },
);
