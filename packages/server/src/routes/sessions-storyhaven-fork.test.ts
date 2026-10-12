import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { branchSession } from "./sessions.js";
import { getMemoryRuntime, closeMemoryRuntime } from "../memory/runtime.js";
import {
  loadStoryhavenTurnContext,
  stopMemoryWorker,
} from "../memory/yumina-adapter.js";
import {
  ensureIdentity,
  ensureProfileSchema,
  quoteSchema,
} from "../memory/schema.js";
import { createMemoryRepositories } from "../memory/repositories/index.js";
import {
  saveSessionSnapshot,
  loadSessionSnapshot,
  factForgetHash,
} from "../memory/snapshots.js";
import { decryptMemoryText } from "../memory/crypto.js";

test("a StoryHaven branch freezes its eligible selected checkpoint and forget ledger independently of later parent changes", async (t) => {
  await ensureStoryhavenMemoryTables();
  const r = await getMemoryRuntime();
  t.after(async () => {
    await stopMemoryWorker();
    await closeMemoryRuntime();
  });
  const uid = crypto.randomUUID();
  await db
    .insert(user)
    .values({ id: uid, name: "Fork player", email: `${uid}@test.local` });
  const worldSchema = {
    name: "Mira",
    entries: [],
    variables: [],
    version: "21.0.0",
  };
  const [w] = await db
    .insert(worlds)
    .values({ creatorId: uid, name: "Fork world", schema: worldSchema })
    .returning();
  const [p] = await db
    .insert(playSessions)
    .values({
      userId: uid,
      worldId: w!.id,
      state: { variables: {} },
      name: "Parent",
      sessionMemoryPinned: "Manual standing note",
    })
    .returning();
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET backend='storyhaven',settings=${JSON.stringify({ settleMarginExchanges: 0, model: "fixture-memory", language: "French" })}::jsonb,frontier=1 WHERE session_id=${p!.id}`,
  );
  const rows = Array.from({ length: 3 }, (_, i) => [
    {
      id: `${uid}:u${i}`,
      sessionId: p!.id,
      role: "user" as const,
      content: `Question ${i}`,
      createdAt: new Date(1000 + i * 2000),
    },
    {
      id: `${uid}:a${i}`,
      sessionId: p!.id,
      role: "assistant" as const,
      content: `Selected answer ${i}`,
      swipes: [
        { content: `Selected answer ${i}`, createdAt: "2020-01-01" },
        { content: `Unselected future swipe ${i}`, createdAt: "2020-01-02" },
      ],
      activeSwipeIndex: 0,
      createdAt: new Date(2000 + i * 2000),
    },
  ]).flat();
  await db.insert(messages).values(rows);
  // Null and tied timestamps must retain source identity order after new UUIDs.
  await db
    .update(messages)
    .set({ createdAt: null })
    .where(eq(messages.id, `${uid}:u0`));
  await db
    .update(messages)
    .set({ createdAt: new Date(2000) })
    .where(eq(messages.id, `${uid}:u1`));
  const profile = await r.profiles.create(uid, {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "fixture",
    dimensions: 3,
  });
  await ensureProfileSchema(r.database, profile);
  await r.profiles.setStatus(uid, profile.id, "ready");
  await r.profiles.activate(uid, profile.id, profile.revision);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: uid,
    sessionId: p!.id,
    charId: w!.id,
  };
  await ensureIdentity(r.database, scope);
  const repos = createMemoryRepositories(r.database, scope, r.key),
    vector = [1, 0, 0];
  await repos.facts.recordBatch("fork-b1", 0, 1, 1);
  const old = await repos.facts.insert(
    {
      text: "The gate was closed.",
      fact_type: "state",
      participants: [],
      importance: 4,
      valence: 0,
      turn: 1,
      batch_id: "fork-b1",
    },
    vector,
    true,
  );
  await repos.facts.setCursor(1);
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: uid,
    actingUserId: uid,
    sessionId: p!.id,
  });
  const provenance = {
    worldHash: ctx.worldHash,
    group: false,
    epoch: ctx.epoch,
  };
  await saveSessionSnapshot(
    r.database,
    profile,
    p!.id,
    1,
    ctx.messages,
    r.key,
    provenance,
  );
  await repos.facts.recordBatch("fork-b2", 1, 2, 2);
  const eligible = await repos.facts.supersede(
    old,
    {
      text: "The gate opened at the fork.",
      fact_type: "state",
      participants: [],
      importance: 4,
      valence: 0,
      turn: 2,
      batch_id: "fork-b2",
    },
    vector,
    2,
  );
  await repos.facts.setPinned(eligible, true);
  const forgotten = await repos.facts.insert(
    {
      text: "A forgotten private detail.",
      fact_type: "event",
      participants: [],
      importance: 3,
      valence: 0,
      turn: 2,
      batch_id: "fork-b2",
    },
    vector,
    true,
  );
  await repos.facts.setCursor(2);
  await saveSessionSnapshot(
    r.database,
    profile,
    p!.id,
    2,
    ctx.messages,
    r.key,
    provenance,
  );
  await r.database.query(
    "INSERT INTO memory_forget_ledger(profile_id,session_id,fact_hash) VALUES($1,$2,$3)",
    [profile.id, p!.id, factForgetHash("A forgotten private detail.")],
  );
  await repos.facts.recordBatch("fork-b3", 2, 3, 3);
  await repos.facts.supersede(
    eligible,
    {
      text: "FUTURE PARENT gate sealed.",
      fact_type: "state",
      participants: [],
      importance: 4,
      valence: 0,
      turn: 3,
      batch_id: "fork-b3",
    },
    vector,
    3,
  );
  await repos.facts.setCursor(3);
  await saveSessionSnapshot(
    r.database,
    profile,
    p!.id,
    3,
    ctx.messages,
    r.key,
    provenance,
  );
  const result = await branchSession({
    userId: uid,
    sessionId: p!.id,
    messageId: `${uid}:a1`,
  });
  assert.equal(result.status, 201);
  const child = result.body.data!.sessionId;
  const childContext = await loadStoryhavenTurnContext({
    ownerUserId: uid,
    actingUserId: uid,
    sessionId: child,
  });
  assert.equal(childContext.backend, "storyhaven");
  assert.equal(childContext.frontier, 1);
  assert.equal(childContext.settings.language, "French");
  assert.equal(childContext.settings.model, "fixture-memory");
  assert.equal(childContext.resetEpoch, 0);
  assert.equal(childContext.messages.length, 4);
  assert.deepEqual(
    childContext.messages.map((m) => m.content),
    ["Question 0", "Selected answer 0", "Question 1", "Selected answer 1"],
  );
  const snapshot = await loadSessionSnapshot(
    r.database,
    profile,
    child,
    2,
    childContext.messages,
    r.key,
    { worldHash: childContext.worldHash, group: false, minimumEpoch: 0 },
  );
  assert.ok(
    snapshot,
    "branch must own a frozen checkpoint, independent of its parent",
  );
  assert.equal(snapshot.pairs, 2);
  const texts = snapshot.data.memory_facts.map((f) =>
    decryptMemoryText(String(f.text), r.key),
  );
  assert.ok(texts.includes("The gate opened at the fork."));
  assert.ok(!texts.includes("A forgotten private detail."));
  assert.ok(!texts.some((s) => s.includes("FUTURE PARENT")));
  const remapped = snapshot.data.memory_facts.find(
    (f) =>
      decryptMemoryText(String(f.text), r.key) ===
      "The gate opened at the fork.",
  )!;
  assert.equal(remapped.session_id, child);
  assert.ok(String(remapped.id).startsWith(child + ":"));
  assert.equal(remapped.batch_id, `${child}:fork-b2`);
  assert.equal(
    snapshot.data.memory_facts.find(
      (f) =>
        decryptMemoryText(String(f.text), r.key) === "The gate was closed.",
    )!.superseded_by,
    remapped.id,
  );
  assert.equal(
    (
      await r.database.query(
        "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
        [profile.id, child],
      )
    ).rows[0]?.fact_hash,
    factForgetHash("A forgotten private detail."),
  );
  await repos.facts.updateText(
    eligible,
    "PARENT MANUAL EDIT AFTER FORK",
    vector,
  );
  await r.database.query(
    "DELETE FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
    [profile.id, p!.id],
  );
  await r.database.query(
    "DELETE FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
    [profile.id, p!.id],
  );
  await db.delete(messages).where(eq(messages.sessionId, p!.id));
  const frozen = await loadSessionSnapshot(
    r.database,
    profile,
    child,
    2,
    childContext.messages,
    r.key,
    { worldHash: childContext.worldHash, group: false },
  );
  assert.deepEqual(frozen, snapshot);
  assert.equal(
    (
      await r.database.query(
        `SELECT text FROM ${quoteSchema(profile.schemaName)}.memory_facts WHERE session_id=$1`,
        [child],
      )
    ).rows.length,
    0,
    "fork materialization stores a checkpoint; recall restores it in isolation",
  );
});

async function pendingFixture(t: test.TestContext) {
  await ensureStoryhavenMemoryTables();
  const r = await getMemoryRuntime();
  t.after(async () => {
    await stopMemoryWorker();
    await closeMemoryRuntime();
  });
  const uid = crypto.randomUUID();
  await db.insert(user).values({
    id: uid,
    name: "Pending fork player",
    email: `${uid}@test.local`,
  });
  const [world] = await db
    .insert(worlds)
    .values({
      creatorId: uid,
      name: "Pending fork",
      schema: { name: "Mira", entries: [], variables: [] },
    })
    .returning();
  const [parent] = await db
    .insert(playSessions)
    .values({ userId: uid, worldId: world!.id, state: { variables: {} } })
    .returning();
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET backend='storyhaven',settings='{"settleMarginExchanges":0}'::jsonb WHERE session_id=${parent!.id}`,
  );
  const raw = [
    {
      id: `${uid}:u`,
      sessionId: parent!.id,
      role: "user" as const,
      content: "Before the fork",
      createdAt: new Date(1000),
    },
    {
      id: `${uid}:a`,
      sessionId: parent!.id,
      role: "assistant" as const,
      content: "Selected response",
      createdAt: new Date(2000),
    },
  ];
  await db.insert(messages).values(raw);
  const profile = await r.profiles.create(uid, {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "fixture",
    dimensions: 3,
  });
  await ensureProfileSchema(r.database, profile);
  await r.profiles.setStatus(uid, profile.id, "ready");
  await r.profiles.activate(uid, profile.id, profile.revision);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: uid,
    sessionId: parent!.id,
    charId: world!.id,
  };
  await ensureIdentity(r.database, scope);
  const repos = createMemoryRepositories(r.database, scope, r.key);
  await repos.facts.recordBatch("pending-batch", 0, 1, 1);
  const fact = await repos.facts.insert(
    {
      text: "Frozen source fact.",
      fact_type: "event",
      participants: [],
      importance: 3,
      valence: 0,
      turn: 1,
      batch_id: "pending-batch",
    },
    [1, 0, 0],
    true,
  );
  await repos.facts.setCursor(1);
  const context = await loadStoryhavenTurnContext({
    ownerUserId: uid,
    actingUserId: uid,
    sessionId: parent!.id,
  });
  await saveSessionSnapshot(
    r.database,
    profile,
    parent!.id,
    1,
    context.messages,
    r.key,
    { worldHash: context.worldHash, group: false, epoch: context.epoch },
  );
  const forgetHash = factForgetHash("Previously forgotten detail.");
  await r.database.query(
    "INSERT INTO memory_forget_ledger(profile_id,session_id,fact_hash) VALUES($1,$2,$3)",
    [profile.id, parent!.id, forgetHash],
  );
  return {
    r,
    uid,
    world: world!,
    parent: parent!,
    profile,
    raw,
    context,
    repos,
    fact,
    forgetHash,
  };
}

async function capturePending(
  f: Awaited<ReturnType<typeof pendingFixture>>,
  beforeCommit?: (child: string) => void,
) {
  const { captureStoryhavenMemoryFork } = await import("../memory/fork.js");
  const { memoryTranscriptRow } = await import("../memory/yumina-adapter.js");
  return db.transaction(async (tx) => {
    const [child] = await tx
      .insert(playSessions)
      .values({
        userId: f.uid,
        worldId: f.world.id,
        state: { variables: {} },
        parentSessionId: f.parent.id,
      })
      .returning();
    const copies = f.raw.map((r, i) => ({
      ...r,
      id: `${child!.id}:${i}`,
      sessionId: child!.id,
    }));
    await tx.insert(messages).values(copies);
    await captureStoryhavenMemoryFork(tx, {
      ownerUserId: f.uid,
      parentSessionId: f.parent.id,
      childSessionId: child!.id,
      parentMessages: f.context.messages,
      childMessages: copies.map(memoryTranscriptRow),
      worldHash: f.context.worldHash,
      group: false,
    });
    beforeCommit?.(child!.id);
    return child!.id;
  });
}

test("fork capture rolls back with the app transaction and writes no separate memory state", async (t) => {
  const f = await pendingFixture(t);
  let rolledBackChild = "";
  await assert.rejects(
    capturePending(f, (child) => {
      rolledBackChild = child;
      throw new Error("synthetic app rollback");
    }),
    /synthetic app rollback/,
  );
  assert.equal(
    (
      await db
        .select()
        .from(playSessions)
        .where(eq(playSessions.id, rolledBackChild))
    ).length,
    0,
  );
  assert.equal(
    (
      await db.execute(
        sql`SELECT id FROM storyhaven_memory_outbox WHERE session_id=${rolledBackChild}`,
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await f.r.database.query(
        "SELECT session_id FROM memory_snapshots WHERE session_id=$1",
        [rolledBackChild],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await f.r.database.query(
        "SELECT session_id FROM memory_forget_ledger WHERE session_id=$1",
        [rolledBackChild],
      )
    ).rows.length,
    0,
  );
});

test("delayed fork delivery survives parent deletion and profile activation with original vector provenance", async (t) => {
  const f = await pendingFixture(t),
    child = await capturePending(f);
  const target = await f.r.profiles.create(f.uid, {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "new-embedding",
    dimensions: 4,
  });
  await ensureProfileSchema(f.r.database, target);
  await f.r.profiles.setStatus(f.uid, target.id, "ready");
  await f.r.profiles.activate(f.uid, target.id, target.revision);
  await db.delete(playSessions).where(eq(playSessions.id, f.parent.id));
  await f.r.database.query("DELETE FROM memory_snapshots WHERE session_id=$1", [
    f.parent.id,
  ]);
  await f.r.database.query(
    "DELETE FROM memory_forget_ledger WHERE session_id=$1",
    [f.parent.id],
  );
  const { materializePendingMemoryFork } = await import("../memory/fork.js");
  await materializePendingMemoryFork(f.uid, child);
  const context = await loadStoryhavenTurnContext({
    ownerUserId: f.uid,
    actingUserId: f.uid,
    sessionId: child,
  });
  const checkpoint = await loadSessionSnapshot(
    f.r.database,
    target,
    child,
    1,
    context.messages,
    f.r.key,
    { worldHash: context.worldHash, group: false },
  );
  assert.ok(checkpoint);
  assert.equal(
    checkpoint.profileId,
    f.profile.id,
    "recall must re-embed old-profile vectors",
  );
  assert.deepEqual(
    JSON.parse(String(checkpoint.data.memory_facts[0]!.embedding)),
    [1, 0, 0],
  );
  assert.equal(
    decryptMemoryText(String(checkpoint.data.memory_facts[0]!.text), f.r.key),
    "Frozen source fact.",
  );
  assert.equal(
    (
      await f.r.database.query(
        "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
        [target.id, child],
      )
    ).rows[0]?.fact_hash,
    f.forgetHash,
  );
  // Replay never overwrites a newer accepted snapshot at the same pair count.
  await f.r.database.query(
    "UPDATE memory_snapshots SET payload=$1 WHERE profile_id=$2 AND session_id=$3",
    ["newer accepted opaque payload", target.id, child],
  );
  await db.execute(
    sql`UPDATE storyhaven_memory_outbox SET delivered_at=NULL WHERE session_id=${child} AND kind='fork'`,
  );
  await materializePendingMemoryFork(f.uid, child);
  assert.equal(
    (
      await f.r.database.query(
        "SELECT payload FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
        [target.id, child],
      )
    ).rows[0]?.payload,
    "newer accepted opaque payload",
  );
});

test("fork delivery after child clear keeps persistent forgets and discards the old checkpoint; deleted children cannot resurrect", async (t) => {
  const f = await pendingFixture(t),
    child = await capturePending(f);
  const { materializePendingMemoryFork } = await import("../memory/fork.js");
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET reset_epoch=1,epoch=1 WHERE session_id=${child}`,
  );
  await materializePendingMemoryFork(f.uid, child);
  assert.equal(
    (
      await f.r.database.query(
        "SELECT session_id FROM memory_snapshots WHERE session_id=$1",
        [child],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await f.r.database.query(
        "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
        [f.profile.id, child],
      )
    ).rows[0]?.fact_hash,
    f.forgetHash,
  );
  const removed = await capturePending(f);
  await db.delete(playSessions).where(eq(playSessions.id, removed));
  await materializePendingMemoryFork(f.uid, removed);
  assert.equal(
    (
      await f.r.database.query(
        "SELECT session_id FROM memory_snapshots WHERE session_id=$1",
        [removed],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await f.r.database.query(
        "SELECT session_id FROM memory_forget_ledger WHERE session_id=$1",
        [removed],
      )
    ).rows.length,
    0,
  );
  assert.ok(
    (
      await db.execute(
        sql`SELECT delivered_at FROM storyhaven_memory_outbox WHERE session_id=${removed} AND kind='fork'`,
      )
    ).rows[0]?.delivered_at,
  );
});

test("an unconfigured StoryHaven fork retains the persistent ledger for a later profile activation", async (t) => {
  const f = await pendingFixture(t);
  await f.r.database.query(
    "UPDATE memory_registry.profiles SET active=false WHERE id=$1",
    [f.profile.id],
  );
  const child = await capturePending(f);
  assert.equal(
    (
      await db.execute(
        sql`SELECT backend FROM storyhaven_memory_sessions WHERE session_id=${child}`,
      )
    ).rows[0]?.backend,
    "storyhaven",
  );
  const { materializePendingMemoryFork } = await import("../memory/fork.js");
  await materializePendingMemoryFork(f.uid, child);
  assert.equal(
    (
      await db.execute(
        sql`SELECT delivered_at FROM storyhaven_memory_outbox WHERE session_id=${child} AND kind='fork'`,
      )
    ).rows[0]?.delivered_at,
    null,
  );
  await f.r.profiles.activate(f.uid, f.profile.id, f.profile.revision);
  await materializePendingMemoryFork(f.uid, child);
  assert.equal(
    (
      await f.r.database.query(
        "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
        [f.profile.id, child],
      )
    ).rows[0]?.fact_hash,
    f.forgetHash,
  );
});

test("the durable drain recovers a frozen fork event behind more than 200 copied-message append events", async (t) => {
  const f = await pendingFixture(t);
  // The checkpoint is created after the clone statements, behind their append events.
  const extra = Array.from({ length: 105 }, (_, i) => [
    {
      id: `${f.uid}:u-extra-${i}`,
      sessionId: f.parent.id,
      role: "user" as const,
      content: `Additional question ${i}`,
      createdAt: new Date(3000 + i * 2000),
    },
    {
      id: `${f.uid}:a-extra-${i}`,
      sessionId: f.parent.id,
      role: "assistant" as const,
      content: `Additional answer ${i}`,
      createdAt: new Date(4000 + i * 2000),
    },
  ]).flat();
  await db.insert(messages).values(extra);
  f.raw.push(...extra);
  f.context = await loadStoryhavenTurnContext({
    ownerUserId: f.uid,
    actingUserId: f.uid,
    sessionId: f.parent.id,
  });
  const child = await capturePending(f);
  // Isolate the crash-recovery queue: only this child's clone events + fork remain.
  await db.execute(
    sql`UPDATE storyhaven_memory_outbox SET delivered_at=NOW() WHERE session_id<>${child}`,
  );
  const window = (
    await db.execute(
      sql`SELECT kind FROM storyhaven_memory_outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 200`,
    )
  ).rows;
  assert.equal(window.length, 200);
  assert.ok(window.every((e) => e.kind === "append"));
  const { drainMemoryWork } = await import("../memory/yumina-adapter.js");
  await drainMemoryWork();
  const context = await loadStoryhavenTurnContext({
    ownerUserId: f.uid,
    actingUserId: f.uid,
    sessionId: child,
  });
  const checkpoint = await loadSessionSnapshot(
    f.r.database,
    f.profile,
    child,
    106,
    context.messages,
    f.r.key,
    { worldHash: context.worldHash, group: false },
  );
  assert.ok(
    checkpoint,
    "durable recovery must reach the frozen event beyond its first event page",
  );
  assert.equal(checkpoint.pairs, 1);
  assert.ok(
    (
      await db.execute(
        sql`SELECT delivered_at FROM storyhaven_memory_outbox WHERE session_id=${child} AND kind='fork'`,
      )
    ).rows[0]?.delivered_at,
  );
});
