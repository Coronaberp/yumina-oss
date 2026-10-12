import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
  quoteSchema,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import {
  ProfileReindexAttempts,
  captureProfileTest,
  completeProfileTest,
  captureReindexCredentials,
  reindexProfile,
} from "./profile-reindex.js";
const key = new Uint8Array(32).fill(3);
async function fixture() {
  const db = await createMemoryDatabase();
  await ensureRegistry(db);
  const profiles = new ProfileRepository(db, {
    encrypt: (s) => `cipher:${s}`,
    decrypt: (s) => s.slice(7),
  });
  const source = await profiles.create("u", {
      baseUrl: "http://localhost",
      model: "a",
      dimensions: 2,
      apiKey: "source-key",
    }),
    target = await profiles.create("u", {
      baseUrl: "http://localhost",
      model: "b",
      dimensions: 3,
      apiKey: "target-key",
    });
  for (const p of [source, target]) await ensureProfileSchema(db, p);
  await ensureIdentity(db, {
    profileId: source.id,
    schemaName: source.schemaName,
    ownerUserId: "u",
    sessionId: "s",
    charId: "c",
  });
  await db.query(
    `INSERT INTO ${quoteSchema(source.schemaName)}.memory_facts(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,last_turn,created_ts) VALUES('f','s','c','Text','event','{}',3,0,0,1,1,1)`,
  );
  await profiles.setStatus("u", source.id, "ready");
  await profiles.activate("u", source.id, source.revision);
  return { db, profiles, source, target };
}
test("live reindex attempts exclude a second owner attempt before provider work", async () => {
  const f = await fixture();
  try {
    const attempts = new ProfileReindexAttempts(f.db, () => 1000);
    await attempts.initialize();
    const claim = await attempts.begin("u", f.source, f.target, 100);
    await assert.rejects(
      () => attempts.begin("u", f.source, f.target, 100),
      /in_progress/,
    );
    assert.equal((await f.profiles.get("u", f.target.id))!.status, "pending");
    assert.equal(await attempts.heartbeat(claim, 100), true);
    await assert.rejects(
      () => attempts.begin("foreign", f.source, f.target),
      /scope/,
    );
  } finally {
    await f.db.close();
  }
});
test("expired reindex attempt cannot commit or mark the accepted recovered target failed", async () => {
  const f = await fixture();
  let now = 1000;
  try {
    const attempts = new ProfileReindexAttempts(f.db, () => now);
    await attempts.initialize();
    const old = await attempts.begin("u", f.source, f.target, 10);
    now = 1011;
    const recovered = await attempts.begin("u", f.source, f.target, 100);
    assert.notEqual(old.token, recovered.token);
    await assert.rejects(
      () => f.db.transaction((tx) => attempts.assert(tx, old)),
      /stale/,
    );
    await f.db.transaction(async (tx) => {
      await attempts.assert(tx, recovered);
      const p = new ProfileRepository(tx, {
        encrypt: (s) => s,
        decrypt: (s) => s,
      });
      await p.setStatus("u", f.target.id, "ready");
      await p.activate("u", f.target.id, f.target.revision);
      await attempts.finish(tx, recovered);
    });
    assert.equal(await attempts.fail(old), false);
    assert.equal((await f.profiles.getActive("u"))!.status, "ready");
  } finally {
    await f.db.close();
  }
});
for (const field of ["source", "target"] as const)
  test(`reindex accepts no result after ${field} credential rotates`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        () =>
          reindexProfile({
            ...f,
            ownerUserId: "u",
            key,
            embedding: {
              embed: async () => {
                await f.profiles.updateKey("u", f[field].id, "rotated");
                return [1, 0, 0];
              },
              embedQuery: async () => [],
            },
          }),
        /credential_changed/,
      );
      assert.equal((await f.profiles.getActive("u"))!.id, f.source.id);
      assert.deepEqual(
        (
          await f.db.query(
            `SELECT id FROM ${quoteSchema(f.target.schemaName)}.memory_facts`,
          )
        ).rows,
        [],
      );
    } finally {
      await f.db.close();
    }
  });
test("profile tests do not clobber active readiness, processing reindex status or a newer key", async () => {
  const f = await fixture();
  try {
    const attempts = new ProfileReindexAttempts(f.db, () => 1000);
    await attempts.initialize();
    const active = await captureProfileTest(f.db, f.source);
    assert.equal(
      await completeProfileTest(f.db, f.source, active, false),
      false,
    );
    assert.equal((await f.profiles.getActive("u"))!.status, "ready");
    const testSnapshot = await captureProfileTest(f.db, f.target);
    const claim = await attempts.begin("u", f.source, f.target);
    assert.equal(
      await completeProfileTest(f.db, f.target, testSnapshot, true),
      false,
    );
    assert.equal((await f.profiles.get("u", f.target.id))!.status, "pending");
    await attempts.fail(claim);
    const rotating = await captureProfileTest(f.db, f.target);
    await f.profiles.updateKey("u", f.target.id, "new");
    assert.equal(
      await completeProfileTest(f.db, f.target, rotating, false),
      false,
    );
  } finally {
    await f.db.close();
  }
});
test("reindex checks authoritative epoch callback before accepting canonical copy", async () => {
  const f = await fixture();
  try {
    let current = true;
    await assert.rejects(
      () =>
        reindexProfile({
          ...f,
          ownerUserId: "u",
          key,
          ensureCurrent: async () => current,
          embedding: {
            embed: async () => {
              current = false;
              return [1, 0, 0];
            },
            embedQuery: async () => [],
          },
        }),
      /source_changed/,
    );
    assert.equal((await f.profiles.getActive("u"))!.id, f.source.id);
  } finally {
    await f.db.close();
  }
});
test("reindex refuses forged schema identifiers even when caller declares the right owner", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        reindexProfile({
          ...f,
          source: { ...f.source, schemaName: f.target.schemaName },
          ownerUserId: "u",
          key,
          embedding: {
            embed: async () => {
              throw new Error("should not call");
            },
            embedQuery: async () => [],
          },
        }),
      /profile_changed/,
    );
  } finally {
    await f.db.close();
  }
});
test("lease recovery accepts one full migration and stale provider output cannot clobber its ready target", async () => {
  const f = await fixture();
  let now = 1000;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    const stale = reindexProfile({
      ...f,
      ownerUserId: "u",
      key,
      clock: () => now,
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
      (error) => error.message,
    );
    await started;
    let duplicateCalls = 0;
    await assert.rejects(
      () =>
        reindexProfile({
          ...f,
          ownerUserId: "u",
          key,
          clock: () => now,
          embedding: {
            embed: async () => {
              duplicateCalls++;
              return [1, 0, 0];
            },
            embedQuery: async () => [],
          },
        }),
      /in_progress/,
    );
    assert.equal(duplicateCalls, 0);
    now = 1011;
    await reindexProfile({
      ...f,
      ownerUserId: "u",
      key,
      clock: () => now,
      leaseMs: 100,
      embedding: { embed: async () => [1, 0, 0], embedQuery: async () => [] },
    });
    release();
    assert.match(await stale, /profile_changed|reindex_stale/);
    const active = await f.profiles.getActive("u");
    assert.equal(active!.id, f.target.id);
    assert.equal(active!.status, "ready");
    assert.equal(
      (
        await f.db.query(
          `SELECT id FROM ${quoteSchema(f.target.schemaName)}.memory_facts`,
        )
      ).rows.length,
      1,
    );
  } finally {
    release();
    await f.db.close();
  }
});
test("client credential capture is fenced even when key changes before attempt registration", async () => {
  const f = await fixture();
  try {
    const expectedCredentialHashes = await captureReindexCredentials(
      f.db,
      "u",
      f.source,
      f.target,
    );
    await f.profiles.updateKey("u", f.target.id, "new key");
    let calls = 0;
    await assert.rejects(
      () =>
        reindexProfile({
          ...f,
          ownerUserId: "u",
          key,
          expectedCredentialHashes,
          embedding: {
            embed: async () => {
              calls++;
              return [1, 0, 0];
            },
            embedQuery: async () => [],
          },
        }),
      /credential_changed/,
    );
    assert.equal(calls, 0);
    assert.equal((await f.profiles.getActive("u"))!.id, f.source.id);
  } finally {
    await f.db.close();
  }
});
