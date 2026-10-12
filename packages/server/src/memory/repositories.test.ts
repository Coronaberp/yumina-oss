import type { MemoryDatabase } from "./types.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { createMemoryRepositories } from "./repositories/index.js";
for (const dim of [1024, 3072])
  test(`repositories encrypt and isolate, restore batches and lore/cluster effects at ${dim} dimensions`, async () => {
    const db = await createMemoryDatabase();
    try {
      await ensureRegistry(db);
      const pr = new ProfileRepository(db, {
        encrypt: (s) => s,
        decrypt: (s) => s,
      });
      const p = await pr.create("a", {
        baseUrl: "http://localhost",
        model: "m",
        dimensions: dim,
      });
      await ensureProfileSchema(db, p);
      const scope = {
        profileId: p.id,
        schemaName: p.schemaName,
        ownerUserId: "a",
        sessionId: "s",
        charId: "c",
      };
      await ensureIdentity(db, scope);
      await ensureIdentity(db, { ...scope, sessionId: "other" });
      const r = createMemoryRepositories(db, scope, Buffer.alloc(32, 9)),
        other = createMemoryRepositories(
          db,
          { ...scope, sessionId: "other" },
          Buffer.alloc(32, 9),
        );
      const vec = Array(dim).fill(1);
      const draft = {
        text: "Mira promises to return 🌙",
        fact_type: "promise" as const,
        participants: ["Mira"],
        importance: 4,
        valence: 1,
        turn: 1,
        location: "The café",
      };
      const first = await r.facts.insert(draft, vec, true);
      await r.facts.recordBatch("b1", 0, 5, 1);
      const second = await r.facts.supersede(
        first,
        { ...draft, text: "Mira has returned", turn: 6, batch_id: "b2" },
        vec,
        6,
      );
      await r.facts.recordBatch("b2", 5, 10, 6);
      await r.facts.reinforce(first, 6, "b2");
      await r.facts.reinforce(first, 7, "b2");
      await r.facts.setCursor(10);
      assert.equal((await r.facts.similarLive(vec, 10)).length, 2);
      assert.equal((await r.facts.similarCurrent(vec, 10)).length, 1);
      assert.equal((await r.facts.reserved()).length, 1);
      assert.equal((await other.facts.listLive()).length, 0);
      await assert.rejects(() => other.facts.reinforce(first, 8));
      assert.equal((await r.facts.get(first))!.reinforcements, 2);
      const raw = await db.query<{ text: string; location: string }>(
        `SELECT text,location FROM "${p.schemaName}".memory_facts WHERE id=$1`,
        [first],
      );
      assert.ok(!raw.rows[0]!.text.includes("Mira"));
      assert.ok(!raw.rows[0]!.location.includes("café"));
      assert.equal((await r.facts.lineage([second]))[second]![0]!.id, first);
      const lore = await r.lore.upsert({
        id: "l",
        name: "Gate",
        content: "It is closed",
        keys: ["gate"],
      });
      await r.lore.setChunks(lore.id, ["A", "B"]);
      assert.deepEqual(
        (await r.lore.chunksFor(lore.id)).map((c) => c.part_id),
        [0, 1],
      );
      const secrets = await r.lore.setSecrets(lore.id, ["Key under stone"]);
      await r.lore.reveal(secrets[0]!.id, "b2", second);
      assert.equal((await other.lore.revealedIds([secrets[0]!.id])).size, 0);
      await r.lore.setOverride(lore.id, "It is open", second, "b2");
      assert.equal((await other.lore.getAllOverridesForSession()).l, undefined);
      const cluster = await r.clusters.insert(
        "Promise fulfilled",
        6,
        ["b2"],
        "Return",
        vec,
      );
      await r.clusters.addMembers(cluster, [second]);
      assert.equal((await other.clusters.activeForSession()).length, 0);
      await r.vectors.storeLoreVector(lore.id, vec, 1);
      assert.equal(
        (await r.vectors.searchLoreChunks(vec, 5, 1))[0]!.part_id,
        1,
      );
      await r.lore.upsert({
        id: "global",
        name: "Shared",
        content: "Shared",
        char_id: null,
      });
      await r.vectors.storeLoreVector("global", vec, 0);
      assert.equal((await r.vectors.searchLoreChunks(vec, 5, 1)).length, 1);
      assert.equal(
        (await r.vectors.searchLoreChunks(vec, 5, 1, true)).length,
        2,
      );
      const rollback = await r.facts.rollbackFromPairIndex(7);
      assert.equal(rollback.facts_deleted, 1);
      assert.equal(await r.facts.getCursor(), 5);
      assert.equal((await r.facts.get(first))!.reinforcements, 0);
      assert.equal((await r.facts.get(first))!.last_turn, 1);
      assert.equal((await r.facts.get(first))!.superseded_by, null);
      assert.equal(await r.facts.get(second), null);
      assert.equal(await r.lore.deleteRevealsForBatches(["b2"]), 1);
      assert.equal(await r.clusters.deleteOverlapping(["b2"]), 1);
      assert.equal((await r.clusters.activeForSession()).length, 0);
      await r.facts.purgeSession();
      assert.equal(await r.facts.countLive(), 0);
    } finally {
      await db.close();
    }
  });
test("foreign entity ids and changed scope cannot escape the bound owner/session", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("owner", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 3,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "owner",
      sessionId: "one",
      charId: "a",
    };
    await ensureIdentity(db, scope);
    await ensureIdentity(db, { ...scope, sessionId: "two", charId: "b" });
    const first = createMemoryRepositories(db, scope, Buffer.alloc(32, 1));
    const second = createMemoryRepositories(
      db,
      { ...scope, sessionId: "two", charId: "b" },
      Buffer.alloc(32, 1),
    );
    const vec = [1, 0, 0];
    const draft = {
      text: "Standing",
      fact_type: "state" as const,
      participants: [],
      importance: 3,
      valence: 0,
      turn: 1,
    };
    const fact = await first.facts.insert(draft, vec);
    const lore = await first.lore.upsert({
      id: "private",
      name: "Private",
      content: "private",
      keys: ["p"],
    });
    const secrets = await first.lore.setSecrets(lore.id, ["secret"]);
    const cluster = await first.clusters.insert("summary", 1, [], "title", vec);
    await assert.rejects(() => second.facts.updateText(fact, "hacked", vec));
    await assert.rejects(() => second.facts.supersede(fact, draft, vec, 2));
    assert.equal(await second.facts.countLive(), 0);
    await assert.rejects(() => second.facts.expire(fact));
    assert.equal(await second.facts.deleteFact(fact), 0);
    await assert.rejects(() => second.facts.setPinned(fact, true));
    await assert.rejects(() => second.clusters.addMembers(cluster, [fact]));
    await assert.rejects(() =>
      second.clusters.updateCluster(cluster, "hacked", 2, []),
    );
    await assert.rejects(() => second.vectors.storeClusterVector(cluster, vec));
    await assert.rejects(() => second.lore.setChunks(lore.id, ["hacked"]));
    await assert.rejects(() => second.lore.deleteSecrets(lore.id));
    await assert.rejects(() =>
      second.lore.setOverride(lore.id, "hacked", fact),
    );
    await assert.rejects(() => second.lore.reveal(secrets[0]!.id));
    assert.deepEqual(await second.lore.secretsByIds([secrets[0]!.id]), []);
    assert.equal(await second.lore.get(lore.id), null);
    assert.deepEqual(await second.lore.byIds([lore.id]), []);
    await assert.rejects(() => second.lore.upsert({ ...lore, name: "hacked" }));
    await assert.rejects(() => first.facts.insert(draft, [1, 0]));
    assert.equal(await first.facts.countLive(), 1);
    scope.sessionId = "two";
    scope.charId = "b";
    assert.equal((await first.facts.listLive()).length, 1);
    await first.facts.setSceneState("Walking", "Beach", ["Nia"]);
    assert.deepEqual(await first.facts.getSceneState(), {
      doing: "Walking",
      location: "Beach",
      npcs: ["Nia"],
    });
    assert.deepEqual(await second.facts.getSceneState(), {
      doing: "",
      location: "",
      npcs: [],
    });
  } finally {
    await db.close();
  }
});
test("transaction-bound repository writes roll back together; override prior and reveal fact rollback are exact", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("owner", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "owner",
      sessionId: "s",
      charId: "c",
    };
    await ensureIdentity(db, scope);
    const key = Buffer.alloc(32, 3),
      vec = [1, 0],
      r = createMemoryRepositories(db, scope, key);
    const draft = {
      text: "fact",
      fact_type: "event" as const,
      participants: [],
      importance: 3,
      valence: 0,
      turn: 1,
    };
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        const bound = createMemoryRepositories(tx, scope, key);
        await bound.facts.insert(draft, vec);
        await bound.facts.recordBatch("aborted", 0, 5, 1);
        await bound.facts.setCursor(5);
        throw new Error("fenced");
      }),
    );
    assert.equal(await r.facts.countLive(), 0);
    assert.equal(await r.facts.getCursor(), 0);
    assert.deepEqual(await r.facts.batches(), []);
    const l = await r.lore.upsert({ id: "l", name: "Door", content: "closed" });
    const f1 = await r.facts.insert({ ...draft, text: "first" }, vec),
      f2 = await r.facts.insert({ ...draft, text: "second" }, vec);
    await r.lore.setOverride(l.id, "manual", f1);
    await r.lore.setOverride(l.id, "automatic", f2, "b2");
    await r.lore.setOverride(l.id, "same batch correction", f2, "b2");
    assert.equal(
      (await r.lore.getState(l.id))!.prior_override_content,
      "manual",
    );
    await r.lore.restorePrior(l.id);
    assert.equal((await r.lore.getState(l.id))!.override_content, "manual");
    assert.equal((await r.lore.getState(l.id))!.batch_id, null);
    const ss = await r.lore.setSecrets(l.id, ["a"]);
    await r.lore.reveal(ss[0]!.id, "b2", f2);
    await r.lore.reveal(ss[0]!.id, "b3", f1);
    assert.equal(await r.lore.deleteRevealsForBatches(["b2"]), 1);
    assert.equal(await r.facts.get(f2), null);
    assert.ok(await r.facts.get(f1));
    assert.equal(await r.lore.clearOverride(l.id), f1);
    assert.deepEqual(await r.lore.getAllOverridesForSession(), {});
    const linked = await r.lore.upsert({
      id: "b",
      name: "Other",
      content: "elsewhere",
    });
    await r.lore.addLink(l.id, linked.id, "leads to");
    assert.equal((await r.lore.linksFor([linked.id]))[0]!.lore_id_a, l.id);
    await r.lore.addLink(linked.id, l.id, "returns");
    assert.equal((await r.lore.linksFor([l.id])).length, 1);
    await assert.rejects(() => r.lore.addLink(l.id, l.id));
    const c = await r.clusters.insert("summary", 1, []);
    await r.clusters.addMembers(c, [f1]);
    await r.clusters.addMembers(c, [f1]);
    assert.deepEqual(await r.clusters.members(c), [f1]);
    assert.deepEqual(await r.clusters.unclusteredFacts(), []);
  } finally {
    await db.close();
  }
});
test("lore metadata, labeled links, keyword normalization and batch identities match protected source layout", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("u", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "u",
      sessionId: "s",
      charId: "c",
    };
    await ensureIdentity(db, scope);
    await ensureIdentity(db, { ...scope, sessionId: "other" });
    const r = createMemoryRepositories(db, scope, Buffer.alloc(32, 8)),
      other = createMemoryRepositories(
        db,
        { ...scope, sessionId: "other" },
        Buffer.alloc(32, 8),
      );
    const a = await r.lore.upsert({
        id: "a",
        name: "A",
        content: "c",
        keys: ["  gate ", "", " door"],
        metadata: { secret: "hidden metadata" },
      }),
      b = await r.lore.upsert({ id: "b", name: "B", content: "c" });
    assert.deepEqual(a.keys, ["gate", "door"]);
    await r.lore.addLink(a.id, b.id, `  ${"🌙".repeat(70)}  `);
    assert.equal((await r.lore.linksFor([a.id]))[0]!.label, "🌙".repeat(60));
    const raw = await db.query<{ metadata: string }>(
      `SELECT metadata FROM "${p.schemaName}".lore WHERE id=$1`,
      [a.id],
    );
    assert.ok(!raw.rows[0]!.metadata.includes("hidden metadata"));
    assert.deepEqual((await r.lore.get(a.id))!.metadata, {
      secret: "hidden metadata",
    });
    await other.facts.recordBatch("foreign", 0, 5, 1);
    const draft = {
      text: "f",
      fact_type: "event" as const,
      participants: [],
      importance: 3,
      valence: 0,
      turn: 1,
    };
    await assert.rejects(() =>
      r.facts.insert({ ...draft, batch_id: "foreign" }, [1, 0]),
    );
    const fact = await r.facts.insert(draft, [1, 0]);
    await assert.rejects(() => r.facts.reinforce(fact, 2, "foreign"));
    assert.equal((await r.facts.get(fact))!.reinforcements, 0);
    await assert.rejects(() => r.clusters.insert("wrong", 1, ["foreign"]));
  } finally {
    await db.close();
  }
});
test("lore content changes invalidate secrets and vectors and empty overrides preserve source null distinctions", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("u", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "u",
      sessionId: "s",
      charId: "c",
    };
    await ensureIdentity(db, scope);
    const r = createMemoryRepositories(db, scope, Buffer.alloc(32, 4));
    const l = await r.lore.upsert({ id: "l", name: "Lore", content: "old" });
    const secrets = await r.lore.setSecrets(l.id, ["old secret"]);
    await r.vectors.storeSecretVector(secrets[0]!.id, l.id, [1, 0]);
    await r.lore.upsert({ id: "l", name: "Lore", content: "old" });
    assert.equal((await r.lore.secretsFor(l.id)).length, 1);
    await r.lore.upsert({ id: "l", name: "Lore", content: "new" });
    assert.deepEqual(await r.lore.secretsFor(l.id), []);
    assert.deepEqual(await r.vectors.searchSecretIds([1, 0], 10, 1), []);
    await r.lore.setOverride(l.id, "", null);
    assert.equal((await r.lore.getState(l.id))!.override_content, "");
    await r.lore.setOverride(l.id, "next", null, "b");
    assert.equal((await r.lore.getState(l.id))!.prior_override_content, "");
    await r.lore.restorePrior(l.id);
    assert.equal((await r.lore.getState(l.id))!.override_content, "");
  } finally {
    await db.close();
  }
});
test("colliding stable lore ids cannot replace a different character scope", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("u", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "u",
      sessionId: "a",
      charId: "a",
    };
    await ensureIdentity(db, scope);
    await ensureIdentity(db, { ...scope, sessionId: "b", charId: "b" });
    const a = createMemoryRepositories(db, scope, Buffer.alloc(32, 4)),
      b = createMemoryRepositories(
        db,
        { ...scope, sessionId: "b", charId: "b" },
        Buffer.alloc(32, 4),
      );
    const results = await Promise.allSettled([
      a.lore.upsert({ id: "shared", name: "A", content: "A" }),
      b.lore.upsert({ id: "shared", name: "B", content: "B" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const first = results[0]!.status === "fulfilled";
    assert.equal(
      (await (first ? a : b).lore.get("shared"))!.content,
      first ? "A" : "B",
    );
    assert.equal(await (first ? b : a).lore.get("shared"), null);
  } finally {
    await db.close();
  }
});
test("lore conflict predicate rejects a foreign row appearing between check and insert", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const pr = new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const p = await pr.create("u", {
      baseUrl: "http://localhost",
      model: "m",
      dimensions: 2,
    });
    await ensureProfileSchema(db, p);
    const scope = {
      profileId: p.id,
      schemaName: p.schemaName,
      ownerUserId: "u",
      sessionId: "a",
      charId: "a",
    };
    await ensureIdentity(db, scope);
    let interleaved = false;
    const raceDb = {
      ...db,
      transaction: async <T>(work: (tx: MemoryDatabase) => Promise<T>) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: async <R extends Record<string, unknown>>(
              sql: string,
              values?: unknown[],
            ) => {
              const result = await tx.query<R>(sql, values);
              if (
                sql.includes("SELECT owner_id,char_id,content") &&
                !result.rows.length
              ) {
                interleaved = true;
                await tx.query(
                  `INSERT INTO "${p.schemaName}".lore(id,char_id,owner_id,name,content,created) VALUES('collision','b','u','B','B',1)`,
                );
              }
              return result;
            },
          }),
        ),
    };
    const r = createMemoryRepositories(raceDb, scope, Buffer.alloc(32, 4));
    await assert.rejects(
      () => r.lore.upsert({ id: "collision", name: "A", content: "A" }),
      /ownership conflict/,
    );
    assert.ok(interleaved);
  } finally {
    await db.close();
  }
});
