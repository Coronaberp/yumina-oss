import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createMemoryService } from "./service.js";
import { createMemoryRepositories } from "./repositories/index.js";
import { MemoryJobs } from "./jobs.js";
import { reindexProfile } from "./profile-reindex.js";
import {
  saveSessionSnapshot,
  loadSessionSnapshot,
  remapSnapshot,
} from "./snapshots.js";
import {
  CANONICAL_TABLES,
  insertCanonical,
  type CanonicalData,
} from "./profile-reindex.js";
import { ensureIdentity } from "./schema.js";
import type { FactDraft, MemoryModel } from "./types.js";
import {
  memoryFixture,
  context,
  deferred,
  messages,
} from "./test-support/integration.js";
const serviceGolden = JSON.parse(
  readFileSync(
    new URL("./test-support/service-golden.json", import.meta.url),
    "utf8",
  ),
);
test("service recall golden records the pinned original algorithm hashes", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("./source-manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(serviceGolden.commit, manifest.commit);
  for (const [path, hash] of Object.entries(serviceGolden.sourceHashes))
    assert.equal(hash, manifest.files[path], path);
});
const firstDrafts: FactDraft[] = [
  {
    text: "Mira promised to return.",
    fact_type: "promise",
    participants: ["Mira"],
    importance: 4,
    valence: 0,
  },
  {
    text: "The gate remains closed.",
    fact_type: "state",
    participants: [],
    importance: 4,
    valence: 0,
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    text: `Earlier event ${i + 1} occurred.`,
    fact_type: "event" as const,
    participants: [],
    importance: 3,
    valence: 0,
  })),
];
const secondDrafts: FactDraft[] = [
  { ...firstDrafts[0]! },
  { ...firstDrafts[1]!, text: "The gate is open." },
  ...Array.from({ length: 7 }, (_, i) => ({
    text: `Later event ${i + 1} occurred.`,
    fact_type: "event" as const,
    participants: [],
    importance: 3,
    valence: 0,
  })),
];
for (const dimensions of [1024, 3072])
  test(`real service extraction, reconciliation, lore and historical recall at ${dimensions} dimensions`, async () => {
    const f = await memoryFixture(dimensions);
    try {
      const jobs = new MemoryJobs(f.db);
      await jobs.initialize();
      const lore = await f.repositories.lore.upsert({
        id: "gate-lore",
        name: "Gate",
        content: "The city gate is closed.",
      });
      await f.repositories.vectors.storeLoreVector(lore.id, f.vector);
      const [secret] = await f.repositories.lore.setSecrets(lore.id, [
        "The key is under the stone.",
      ]);
      await f.repositories.vectors.storeSecretVector(
        secret!.id,
        lore.id,
        f.vector,
      );
      let batch = 0,
        inTransaction = false,
        oldPromise = "",
        oldState = "",
        clusterCalls = 0;
      const prompts: string[] = [];
      const model: MemoryModel = {
        async complete(prompt) {
          assert.equal(
            inTransaction,
            false,
            "provider called inside transaction",
          );
          prompts.push(prompt);
          if (prompt.startsWith("Analyze this roleplay")) {
            batch++;
            return JSON.stringify({
              facts: batch === 1 ? firstDrafts : secondDrafts,
              char_state: {
                doing: "watching the gate",
                location: "Gate",
                npcs: ["Tomas"],
              },
            });
          }
          if (prompt.startsWith("You maintain a story's memory database"))
            return JSON.stringify(
              (batch === 1 ? firstDrafts : secondDrafts).map((_, index) =>
                batch === 2 && index === 0
                  ? { index, action: "reinforce", target_id: oldPromise }
                  : batch === 2 && index === 1
                    ? { index, action: "supersede", target_id: oldState }
                    : { index, action: "add" },
              ),
            );
          if (prompt.startsWith("You maintain a story's world lorebook"))
            return batch === 1
              ? "[]"
              : JSON.stringify([
                  {
                    index: 1,
                    lore_id: lore.id,
                    new_content: "The city gate stands open.",
                  },
                ]);
          if (prompt.startsWith("You maintain a story's hidden lore secrets"))
            return batch === 1
              ? "[]"
              : JSON.stringify([{ index: 2, secret_id: secret!.id }]);
          if (
            prompt.startsWith("Summarize the following story facts") ||
            prompt.startsWith("Here is the story so far")
          ) {
            clusterCalls++;
            return batch === 1
              ? "Mira's promise and the closed gate shaped the journey."
              : "Mira returned; the gate opened and the hidden key came to light.";
          }
          throw new Error("Unexpected integration model prompt");
        },
      };
      const embedding = {
        async embed() {
          assert.equal(
            inTransaction,
            false,
            "embedding called inside transaction",
          );
          return f.vector;
        },
        async embedQuery() {
          assert.equal(inTransaction, false);
          return f.vector;
        },
      };
      const service = createMemoryService({
        repositories: f.repositories,
        model,
        embedding,
        onBatchCommit: async (_meta, write) =>
          f.db.transaction(async (tx) => {
            inTransaction = true;
            try {
              await write(createMemoryRepositories(tx, f.scope, f.key));
            } finally {
              inTransaction = false;
            }
          }),
        onBatchCommitted: async (meta) =>
          saveSessionSnapshot(
            f.db,
            f.profile,
            f.scope.sessionId,
            meta.pairEnd,
            meta.ctx.messages,
            f.key,
          ),
      });
      assert.deepEqual(await service.extractSettled(context(5)), []);
      assert.equal(prompts.length, 0);
      const first = await service.extractSettled(context(6));
      assert.equal(first[0]!.added, 8);
      assert.equal(await f.repositories.facts.getCursor(), 5);
      assert.equal(clusterCalls, 1);
      const initial = await f.repositories.facts.listAll();
      oldPromise = initial.find((v) => v.text === firstDrafts[0]!.text)!.id;
      oldState = initial.find((v) => v.text === firstDrafts[1]!.text)!.id;
      const second = await service.extractSettled(context(11));
      assert.deepEqual(
        second.map((s) => [
          s.added,
          s.reinforced,
          s.superseded,
          s.lore_updates_applied,
          s.secrets_revealed,
        ]),
        [[7, 1, 1, 1, 1]],
      );
      assert.equal(await f.repositories.facts.getCursor(), 10);
      assert.equal(clusterCalls, 2);
      assert.equal(
        (await f.repositories.facts.get(oldPromise))!.reinforcements,
        1,
      );
      assert.equal(
        (await f.repositories.facts.get(oldState))!.valid_until_turn,
        10,
      );
      const visible = await service.retrieveBlock({
        ...context(11),
        loreEntries: [{ ...lore, query_matched: true }],
      });
      assert.equal(visible.block, serviceGolden.block);
      assert.deepEqual(visible.memoryLines, serviceGolden.memoryLines);
      assert.deepEqual(visible.loreLines, ["- The city gate stands open."]);
      const historical = await loadSessionSnapshot(
        f.db,
        f.profile,
        f.scope.sessionId,
        5,
        messages(11),
        f.key,
      );
      assert.ok(historical);
      assert.equal(historical.pairs, 5);
      const beforePromise = historical.data.memory_facts.find(
        (v) => v.id === oldPromise,
      )!;
      assert.equal(beforePromise.reinforcements, 0);
      assert.equal(
        historical.data.memory_facts.find((v) => v.id === oldState)!
          .valid_until_turn,
        null,
      );
      assert.equal(historical.data.session_secret_reveals.length, 0);
      assert.equal(historical.data.session_lore_state.length, 0);
      assert.equal(historical.data.memory_clusters.length, 1);
      assert.equal(historical.data.memory_clusters[0]!.created_turn, 5);
      assert.equal(
        (await f.repositories.lore.revealedIds([secret!.id])).size,
        1,
      );
      const forkScope = { ...f.scope, sessionId: "fork" };
      await ensureIdentity(f.db, forkScope);
      const fork = remapSnapshot(historical.data, "fork");
      const derived = Object.fromEntries(
        CANONICAL_TABLES.map((table) => [
          table,
          [
            "users",
            "characters",
            "sessions",
            "lore",
            "lore_links",
            "lore_secrets",
            "lore_chunks",
            "lore_vectors",
            "secret_vectors",
          ].includes(table)
            ? []
            : fork[table],
        ]),
      ) as CanonicalData;
      await insertCanonical(f.db, f.profile, derived);
      const forkRepos = createMemoryRepositories(f.db, forkScope, f.key);
      assert.equal(
        (await forkRepos.facts.get(`fork:${oldPromise}`))!.reinforcements,
        0,
      );
      assert.equal(
        (await forkRepos.facts.get(`fork:${oldState}`))!.valid_until_turn,
        null,
      );
      assert.equal(
        (await forkRepos.lore.getAllOverridesForSession())[lore.id],
        undefined,
      );
      assert.equal((await forkRepos.lore.revealedIds([secret!.id])).size, 0);
      await forkRepos.facts.recordBatch("fork-next", 5, 10, 10);
      await forkRepos.facts.reinforce(`fork:${oldPromise}`, 10, "fork-next");
      assert.equal(
        (await forkRepos.facts.get(`fork:${oldPromise}`))!.reinforcements,
        1,
      );
      assert.equal(
        (await f.repositories.facts.get(oldPromise))!.reinforcements,
        1,
      );
      await forkRepos.facts.reinforce(`fork:${oldPromise}`, 11, "fork-next");
      assert.equal(
        (await forkRepos.facts.get(`fork:${oldPromise}`))!.reinforcements,
        2,
      );
      assert.equal(
        (await f.repositories.facts.get(oldPromise))!.reinforcements,
        1,
      );
    } finally {
      await f.db.close();
    }
  });
test("rejected transaction after prepared writes rolls back the entire source batch", async () => {
  const f = await memoryFixture();
  try {
    let embeddings = 0;
    const service = createMemoryService({
      repositories: f.repositories,
      model: {
        complete: async (p) =>
          p.startsWith("Analyze")
            ? JSON.stringify({
                facts: [firstDrafts[0]],
                char_state: { location: "Rejected scene" },
              })
            : '[{"index":0,"action":"add"}]',
      },
      embedding: {
        embed: async () => {
          embeddings++;
          return f.vector;
        },
        embedQuery: async () => f.vector,
      },
      onBatchCommit: async (_meta, write) =>
        f.db.transaction(async (tx) => {
          await write(createMemoryRepositories(tx, f.scope, f.key));
          assert.equal(
            await createMemoryRepositories(
              tx,
              f.scope,
              f.key,
            ).facts.countLive(),
            1,
          );
          throw new Error("commit rejected");
        }),
    });
    await assert.rejects(service.extractSettled(context(6)), /commit rejected/);
    assert.ok(embeddings > 0);
    assert.equal(await f.repositories.facts.countLive(), 0);
    assert.equal(await f.repositories.facts.getCursor(), 0);
    assert.deepEqual(await f.repositories.facts.batches(), []);
    assert.equal((await f.repositories.facts.getSceneState()).location, "");
  } finally {
    await f.db.close();
  }
});

test("real service catch-up stores 5,5,4 settled exchanges and repeated call makes no new provider calls", async () => {
  const f = await memoryFixture();
  try {
    let invocations = 0;
    const service = createMemoryService({
      repositories: f.repositories,
      model: {
        async complete() {
          invocations++;
          return '{"facts":[],"char_state":{}}';
        },
      },
      embedding: {
        embed: async () => f.vector,
        embedQuery: async () => f.vector,
      },
      onBatchCommit: async (_meta, write) =>
        f.db.transaction((tx) =>
          write(createMemoryRepositories(tx, f.scope, f.key)),
        ),
    });
    await service.extractSettled(context(15));
    assert.deepEqual(
      (await f.repositories.facts.batches()).map((b) => [
        b.pair_start,
        b.pair_end,
        b.turn,
      ]),
      [
        [0, 5, 5],
        [5, 10, 10],
        [10, 14, 14],
      ],
    );
    assert.equal(invocations, 3);
    assert.equal(await f.repositories.facts.getCursor(), 14);
    await service.extractSettled(context(15));
    assert.equal(invocations, 3);
  } finally {
    await f.db.close();
  }
});

test("successor lease fencing rejects an entire prepared source batch with no fact, scene or cursor write", async () => {
  const f = await memoryFixture();
  try {
    let clock = 0;
    const jobs = new MemoryJobs(f.db, () => clock);
    await jobs.initialize();
    await jobs.syncEpoch(f.profile.id, f.scope.sessionId, 0);
    await jobs.enqueue({
      profileId: f.profile.id,
      sessionId: f.scope.sessionId,
      epoch: 0,
      sourceHash: "source-6",
      kind: "extract",
      payload: {},
    });
    const old = await jobs.claim(10);
    assert.ok(old);
    const paused = deferred(),
      release = deferred();
    let blocked = false;
    const service = createMemoryService({
      repositories: f.repositories,
      model: {
        async complete(p) {
          return p.startsWith("Analyze")
            ? JSON.stringify({
                facts: [firstDrafts[0]],
                char_state: { location: "Future place" },
              })
            : '[{"index":0,"action":"add"}]';
        },
      },
      embedding: {
        async embed() {
          if (!blocked) {
            blocked = true;
            paused.resolve();
            await release.promise;
          }
          return f.vector;
        },
        embedQuery: async () => f.vector,
      },
      onBatchCommit: async (_batch, write) =>
        f.db.transaction(async (tx) => {
          await jobs.assertClaim(tx, old);
          await write(createMemoryRepositories(tx, f.scope, f.key));
        }),
    });
    const run = service.extractSettled(context(6));
    await paused.promise;
    clock = 11;
    const successor = await jobs.claim(100);
    assert.ok(successor);
    assert.equal(successor.id, old.id);
    assert.notEqual(successor.token, old.token);
    release.resolve();
    await assert.rejects(run, /memory_stale_claim/);
    assert.equal(await f.repositories.facts.countLive(), 0);
    assert.equal(await f.repositories.facts.getCursor(), 0);
    assert.deepEqual(await f.repositories.facts.batches(), []);
    assert.equal((await f.repositories.facts.getSceneState()).location, "");
    assert.equal(await jobs.finish(old), false);
    assert.equal(await jobs.finish(successor), true);
  } finally {
    await f.db.close();
  }
});

test("profile activation during reindex embedding rejects destination commit and preserves newly active profile", async () => {
  const f = await memoryFixture();
  try {
    await f.repositories.facts.insert(
      {
        text: "Source fact",
        fact_type: "event",
        participants: [],
        importance: 3,
        valence: 0,
        turn: 1,
      },
      f.vector,
    );
    const target = await f.profiles.create("owner", {
      baseUrl: "http://fixture.invalid",
      model: "target",
      dimensions: 4,
    });
    const other = await f.profiles.create("owner", {
      baseUrl: "http://fixture.invalid",
      model: "other",
      dimensions: 3,
    });
    const { ensureProfileSchema } = await import("./schema.js");
    await ensureProfileSchema(f.db, target);
    await ensureProfileSchema(f.db, other);
    await f.profiles.setStatus("owner", other.id, "ready");
    const paused = deferred(),
      release = deferred();
    let calls = 0;
    const run = reindexProfile({
      db: f.db,
      profiles: f.profiles,
      ownerUserId: "owner",
      source: f.profile,
      target,
      key: f.key,
      embedding: {
        async embed() {
          calls++;
          paused.resolve();
          await release.promise;
          return [1, 0, 0, 0];
        },
        embedQuery: async () => [1, 0, 0, 0],
      },
    });
    await paused.promise;
    await f.profiles.activate("owner", other.id, other.revision);
    release.resolve();
    await assert.rejects(run, /memory_profile_changed/);
    assert.equal((await f.profiles.getActive("owner"))!.id, other.id);
    assert.equal((await f.profiles.get("owner", target.id))!.status, "failed");
    assert.equal(
      (
        await f.db.query(
          `SELECT count(*) AS count FROM "${target.schemaName}".memory_facts`,
        )
      ).rows[0]!.count,
      0,
    );
    assert.equal(await f.repositories.facts.countLive(), 1);
    assert.equal(calls, 1);
  } finally {
    await f.db.close();
  }
});
test("successful reindex preserves canonical effects and accepts the next reinforcement log", async () => {
  const f = await memoryFixture();
  try {
    const jobs = new MemoryJobs(f.db);
    await jobs.initialize();
    await jobs.syncEpoch(f.profile.id, f.scope.sessionId, 3);
    await f.repositories.facts.recordBatch("source-batch", 0, 5, 1);
    const id = await f.repositories.facts.insert(
      {
        text: "Persistent fact",
        fact_type: "state",
        participants: ["Mira"],
        importance: 4,
        valence: 0,
        turn: 1,
        batch_id: "source-batch",
      },
      f.vector,
    );
    await f.repositories.facts.reinforce(id, 2, "source-batch");
    await f.repositories.facts.setCursor(5);
    await f.db.query(
      "INSERT INTO memory_forget_ledger(profile_id,session_id,fact_hash) VALUES($1,$2,$3)",
      [f.profile.id, f.scope.sessionId, "forgotten-fixture"],
    );
    const target = await f.profiles.create("owner", {
      baseUrl: "http://fixture.invalid/v1",
      model: "new-space",
      dimensions: 4,
    });
    const { ensureProfileSchema } = await import("./schema.js");
    await ensureProfileSchema(f.db, target);
    let embeddingCalls = 0;
    await reindexProfile({
      db: f.db,
      profiles: f.profiles,
      ownerUserId: "owner",
      source: f.profile,
      target,
      key: f.key,
      embedding: {
        async embed(text) {
          embeddingCalls++;
          assert.equal(text, "Persistent fact");
          return [1, 0, 0, 0];
        },
        embedQuery: async () => [1, 0, 0, 0],
      },
    });
    assert.equal((await f.profiles.getActive("owner"))!.id, target.id);
    assert.equal(embeddingCalls, 1);
    const targetRepos = createMemoryRepositories(
      f.db,
      { ...f.scope, profileId: target.id, schemaName: target.schemaName },
      f.key,
    );
    assert.equal(await targetRepos.facts.getCursor(), 5);
    assert.equal((await targetRepos.facts.get(id))!.reinforcements, 1);
    assert.equal(
      (await targetRepos.facts.similarCurrent([1, 0, 0, 0], 1))[0]!.id,
      id,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
          [target.id, f.scope.sessionId],
        )
      ).rows[0]!.fact_hash,
      "forgotten-fixture",
    );
    await targetRepos.facts.recordBatch("after-migration", 5, 10, 3);
    await targetRepos.facts.reinforce(id, 3, "after-migration");
    assert.equal((await targetRepos.facts.get(id))!.reinforcements, 2);
    await targetRepos.facts.rollbackFromPairIndex(5);
    assert.equal((await targetRepos.facts.get(id))!.reinforcements, 1);
    assert.equal((await f.repositories.facts.get(id))!.reinforcements, 1);
  } finally {
    await f.db.close();
  }
});
test("snapshot compatibility covers all extracted non-OOC exchanges", async () => {
  const f = await memoryFixture();
  try {
    await new MemoryJobs(f.db).initialize();
    const source = [
      {
        id: "ooc-user",
        role: "user",
        content: "(╾━╤デ╦︻: [ooc] discuss pacing)",
      },
      { id: "ooc-answer", role: "assistant", content: "(OOC: yes)" },
      ...messages(6),
    ];
    const service = createMemoryService({
      repositories: f.repositories,
      model: { complete: async () => '{"facts":[],"char_state":{}}' },
      embedding: {
        embed: async () => f.vector,
        embedQuery: async () => f.vector,
      },
      onBatchCommitted: (meta) =>
        saveSessionSnapshot(
          f.db,
          f.profile,
          f.scope.sessionId,
          meta.pairEnd,
          source,
          f.key,
        ),
    });
    await service.extractSettled({ ...context(6), messages: source });
    assert.equal(await f.repositories.facts.getCursor(), 5);
    const changed = source.map((row) =>
      row.id === "a4"
        ? { ...row, content: "Edited the last extracted answer." }
        : row,
    );
    assert.equal(
      await loadSessionSnapshot(
        f.db,
        f.profile,
        f.scope.sessionId,
        5,
        changed,
        f.key,
      ),
      null,
      "edited extracted exchange must invalidate snapshot even with leading OOC exchange",
    );
  } finally {
    await f.db.close();
  }
});
test("snapshot rejects a changed selected answer version or authored world", async () => {
  const f = await memoryFixture();
  try {
    await new MemoryJobs(f.db).initialize();
    await f.repositories.facts.recordBatch("batch", 0, 5, 5);
    await f.repositories.facts.setCursor(5);
    const source = messages(6),
      provenance = { worldHash: "world-A", group: false };
    await saveSessionSnapshot(
      f.db,
      f.profile,
      f.scope.sessionId,
      5,
      source,
      f.key,
      provenance,
    );
    assert.ok(
      await loadSessionSnapshot(
        f.db,
        f.profile,
        f.scope.sessionId,
        5,
        source,
        f.key,
        provenance,
      ),
    );
    assert.equal(
      await loadSessionSnapshot(
        f.db,
        f.profile,
        f.scope.sessionId,
        5,
        source,
        f.key,
        { ...provenance, worldHash: "world-B" },
      ),
      null,
    );
    for (const field of ["sourceVersion", "selectedAnswerId"] as const) {
      const changed = source.map((row) =>
        row.id === "a4" ? { ...row, [field]: "changed-selected-version" } : row,
      );
      assert.equal(
        await loadSessionSnapshot(
          f.db,
          f.profile,
          f.scope.sessionId,
          5,
          changed,
          f.key,
          provenance,
        ),
        null,
        field,
      );
    }
    const fork = source.map((row) => ({ ...row, id: `copy:${row.id}` }));
    assert.ok(
      await loadSessionSnapshot(
        f.db,
        f.profile,
        f.scope.sessionId,
        5,
        fork,
        f.key,
        provenance,
      ),
      "copied branch row ids preserve source provenance",
    );
  } finally {
    await f.db.close();
  }
});
