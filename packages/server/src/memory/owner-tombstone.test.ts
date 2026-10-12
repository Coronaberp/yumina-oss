import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import { ProfileRepository } from "./profiles.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "./schema.js";
import type { MemoryDatabase } from "./types.js";

const input = {
  baseUrl: "http://localhost/v1",
  model: "fixture",
  dimensions: 3,
  apiKey: "fixture-secret",
};

function atTransactionStart(
  db: MemoryDatabase,
  hook: () => Promise<void>,
): MemoryDatabase {
  let pending = true;
  return {
    query: (sql, values) => db.query(sql, values),
    close: () => db.close(),
    transaction: async (work) => {
      if (pending) {
        pending = false;
        await hook();
      }
      return db.transaction(work);
    },
  };
}

test("registry upgrades existing owner counters with a retained deletion tombstone", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    await db.query("CREATE SCHEMA memory_registry");
    await db.query(
      "CREATE TABLE memory_registry.profile_owners(user_id text PRIMARY KEY,next_revision integer NOT NULL DEFAULT 0)",
    );
    await db.query(
      "INSERT INTO memory_registry.profile_owners VALUES('owner',7)",
    );
    await ensureRegistry(db);
    const result = await db.query(
      "SELECT next_revision,deleted FROM memory_registry.profile_owners WHERE user_id='owner'",
    );
    assert.deepEqual(result.rows, [{ next_revision: 7, deleted: false }]);
  } finally {
    await db.close();
  }
});

test("deleted owners cannot recreate a profile or encrypt a new credential", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  let encrypted = 0;
  const repo = new ProfileRepository(db, {
    encrypt: (s) => {
      encrypted++;
      return s;
    },
    decrypt: (s) => s,
  });
  try {
    await ensureRegistry(db);
    await repo.create("owner", input);
    // Model the serialized owner-purge commit, including retained registry identity.
    await db.query(
      "ALTER TABLE memory_registry.profile_owners ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false",
    );
    await db.transaction(async (tx) => {
      await tx.query(
        "SELECT user_id FROM memory_registry.profile_owners WHERE user_id='owner' FOR UPDATE",
      );
      await tx.query(
        "DELETE FROM memory_registry.profiles WHERE user_id='owner'",
      );
      await tx.query(
        "UPDATE memory_registry.profile_owners SET deleted=true WHERE user_id='owner'",
      );
    });
    await assert.rejects(
      () => repo.create("owner", input),
      /Memory owner deleted/,
    );
    assert.equal(encrypted, 1);
    assert.deepEqual(await repo.list("owner"), []);
    const counter = await db.query(
      "SELECT next_revision,deleted FROM memory_registry.profile_owners WHERE user_id='owner'",
    );
    assert.deepEqual(counter.rows, [{ next_revision: 1, deleted: true }]);
  } finally {
    await db.close();
  }
});

test("schema preparation revalidates the owner after entering its DDL transaction", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const profile = await repo.create("owner", input);
    await db.query(
      "ALTER TABLE memory_registry.profile_owners ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false",
    );
    const intercepted = atTransactionStart(db, async () => {
      await db.transaction(async (tx) => {
        await tx.query(
          "UPDATE memory_registry.profile_owners SET deleted=true WHERE user_id='owner'",
        );
        await tx.query(
          "DELETE FROM memory_registry.profiles WHERE user_id='owner'",
        );
      });
    });
    await assert.rejects(
      () => ensureProfileSchema(intercepted, profile),
      /Memory owner deleted/,
    );
    const schema = await db.query(
      "SELECT nspname FROM pg_namespace WHERE nspname=$1",
      [profile.schemaName],
    );
    assert.deepEqual(schema.rows, []);
  } finally {
    await db.close();
  }
});

test("identity writes validate and share-lock the registered profile inside their transaction", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const profile = await repo.create("owner", input);
    await ensureProfileSchema(db, profile);
    const intercepted = atTransactionStart(db, async () => {
      await db.query("DELETE FROM memory_registry.profiles WHERE id=$1", [
        profile.id,
      ]);
    });
    await assert.rejects(
      () =>
        ensureIdentity(intercepted, {
          profileId: profile.id,
          schemaName: profile.schemaName,
          ownerUserId: "owner",
          sessionId: "session",
          charId: "world",
        }),
      /Invalid memory owner scope/,
    );
    const sessions = await db.query(
      `SELECT id FROM "${profile.schemaName}".sessions`,
    );
    assert.deepEqual(sessions.rows, []);
  } finally {
    await db.close();
  }
});

test("identity profile lock precedes canonical inserts and remains transaction-bound", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const profile = await repo.create("owner", input);
    await ensureProfileSchema(db, profile);
    const statements: string[] = [];
    const observed: MemoryDatabase = {
      query: (sql, values) => db.query(sql, values),
      close: () => db.close(),
      transaction: (work) =>
        db.transaction(async (tx) =>
          work({
            ...tx,
            query: (sql, values) => {
              statements.push(sql);
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await ensureIdentity(observed, {
      profileId: profile.id,
      schemaName: profile.schemaName,
      ownerUserId: "owner",
      sessionId: "session",
      charId: "world",
    });
    assert.match(statements[0]!, /memory_registry\.profiles.*FOR SHARE/);
    assert.match(statements[1]!, /INSERT INTO .*users/);
  } finally {
    await db.close();
  }
});
