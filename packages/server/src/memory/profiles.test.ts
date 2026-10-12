import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
test("profile ownership and immutable schema dimensions fence identity and activation", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const a = await repo.create("a", {
      baseUrl: "http://localhost",
      model: "one",
      dimensions: 1,
    });
    const b = await repo.create("b", {
      baseUrl: "http://localhost",
      model: "one",
      dimensions: 1,
    });
    await ensureProfileSchema(db, a);
    assert.notEqual(a.schemaName, b.schemaName);
    await assert.rejects(() => repo.activate("a", a.id, 1));
    await repo.setStatus("a", a.id, "ready");
    await assert.rejects(() => repo.activate("a", a.id, 2));
    await assert.rejects(() => repo.updateKey("b", a.id, "key"));
    await ensureIdentity(db, {
      profileId: a.id,
      schemaName: a.schemaName,
      ownerUserId: "a",
      sessionId: "s",
      charId: "c",
    });
    await assert.rejects(() =>
      ensureIdentity(db, {
        profileId: a.id,
        schemaName: a.schemaName,
        ownerUserId: "b",
        sessionId: "s",
        charId: "c",
      }),
    );
    await assert.rejects(() =>
      ensureProfileSchema(db, { ...a, dimensions: 2 }),
    );
  } finally {
    await db.close();
  }
});
test("profile failures never store provider body or credentials", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await repo.create("u", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await repo.setStatus(
      "u",
      p.id,
      "failed",
      "provider rejected secret-api-key",
    );
    assert.equal((await repo.get("u", p.id))!.errorCode, "validation_failed");
  } finally {
    await db.close();
  }
});
test("new immutable configs get monotonic owner revisions even under concurrent creates", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const profiles = await Promise.all([
      repo.create("u", {
        baseUrl: "http://localhost",
        model: "m1",
        dimensions: 2,
      }),
      repo.create("u", {
        baseUrl: "http://localhost",
        model: "m2",
        dimensions: 2,
      }),
    ]);
    assert.deepEqual(profiles.map((p) => p.revision).sort(), [1, 2]);
    assert.notEqual(profiles[0]!.schemaName, profiles[1]!.schemaName);
  } finally {
    await db.close();
  }
});
test("profile endpoint rejects query/hash credentials before registry persistence", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const repo = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    for (const baseUrl of [
      "http://localhost/v1?api_key=fixture-key",
      "http://localhost/v1#fixture-key",
    ])
      await assert.rejects(() =>
        repo.create("u", { baseUrl, model: "m", dimensions: 2 }),
      );
    assert.deepEqual(await repo.list("u"), []);
  } finally {
    await db.close();
  }
});
