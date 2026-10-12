import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { eq, sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import {
  user,
  worlds,
  worldPendingEdits,
  playSessions,
  messages,
} from "../db/schema.js";
import {
  loadStoryhavenTurnContext,
  ensureStoryhavenSnapshotCurrent,
  stopMemoryWorker,
} from "./yumina-adapter.js";
import { closeMemoryRuntime, getMemoryRuntime } from "./runtime.js";
import { ensureProfileSchema, ensureIdentity } from "./schema.js";
import { createMemoryRepositories } from "./repositories/index.js";
import { saveSessionSnapshot, loadSessionSnapshot } from "./snapshots.js";
import { decryptMemoryText } from "./crypto.js";
import { branchSession } from "../routes/sessions.js";
import { memoryWorldHash } from "./provenance.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
test("creator working-copy contexts use effective world provenance and pending schema changes fence every participant", async (t) => {
  await ensureStoryhavenMemoryTables();
  t.after(async () => {
    await stopMemoryWorker();
    await closeMemoryRuntime();
  });
  const creator = crypto.randomUUID(),
    player = crypto.randomUUID();
  await db.insert(user).values([
    { id: creator, name: "Creator", email: `${creator}@test.local` },
    { id: player, name: "Player", email: `${player}@test.local` },
  ]);
  const live = {
    name: "Live character",
    entries: [
      {
        id: "live",
        role: "lore",
        name: "Live lore",
        content: "Approved live lore",
        alwaysSend: true,
      },
    ],
    variables: [],
  };
  const held = {
    name: "Held character",
    entries: [
      {
        id: "held",
        role: "lore",
        name: "Held lore",
        content: "Private working-copy lore",
        alwaysSend: true,
      },
    ],
    variables: [],
  };
  const [world] = await db
    .insert(worlds)
    .values({
      creatorId: creator,
      name: "Published world",
      status: "published",
      schema: live,
    })
    .returning();
  const sessions = await db
    .insert(playSessions)
    .values([
      { userId: creator, worldId: world!.id, state: { variables: {} } },
      { userId: player, worldId: world!.id, state: { variables: {} } },
    ])
    .returning();
  const own = sessions[0]!,
    other = sessions[1]!;
  await db.insert(worldPendingEdits).values({
    worldId: world!.id,
    createdBy: creator,
    groupKey: world!.id,
    schema: held,
  });
  const storedHeld = (
    await db
      .select({ schema: worldPendingEdits.schema })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, world!.id))
  )[0]!.schema;
  const storedLive = (
    await db
      .select({ schema: worlds.schema })
      .from(worlds)
      .where(eq(worlds.id, world!.id))
  )[0]!.schema;
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
  });
  assert.equal(ctx.worldHash, hash(storedHeld));
  assert.equal(ctx.charName, "Held character");
  assert.equal(ctx.loreEntries[0]?.content, "Private working-copy lore");
  const publicCtx = await loadStoryhavenTurnContext({
    ownerUserId: player,
    actingUserId: player,
    sessionId: other.id,
  });
  assert.equal(publicCtx.worldHash, hash(storedLive));
  assert.equal(publicCtx.charName, "Live character");
  assert.equal(publicCtx.loreEntries[0]?.content, "Approved live lore");
  // A creator acting in a group owner's session must also use and fence the held copy.
  const participant = await loadStoryhavenTurnContext({
    ownerUserId: player,
    actingUserId: creator,
    sessionId: other.id,
  });
  assert.equal(participant.worldHash, hash(storedHeld));
  assert.equal(participant.charName, "Held character");
  assert.ok(await ensureStoryhavenSnapshotCurrent(ctx));
  assert.ok(await ensureStoryhavenSnapshotCurrent(participant));
  const changed = {
    ...held,
    name: "Changed working character",
    entries: [{ ...held.entries[0]!, content: "Changed private lore" }],
  };
  await db
    .update(worldPendingEdits)
    .set({ schema: changed })
    .where(eq(worldPendingEdits.worldId, world!.id));
  assert.equal(await ensureStoryhavenSnapshotCurrent(ctx), false);
  assert.equal(await ensureStoryhavenSnapshotCurrent(participant), false);
  const next = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
  });
  assert.ok(next.epoch > ctx.epoch);
  assert.equal(
    next.worldHash,
    hash(
      (
        await db
          .select({ schema: worldPendingEdits.schema })
          .from(worldPendingEdits)
          .where(eq(worldPendingEdits.worldId, world!.id))
      )[0]!.schema,
    ),
  );
  const stalePassedWorld = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
    world: migrateWorldDefinition(
      structuredClone(held) as unknown as WorldDefinition,
    ),
  });
  assert.equal(
    await ensureStoryhavenSnapshotCurrent(stalePassedWorld),
    false,
    "old route world must not be paired with new effective provenance",
  );
  const currentPassedWorld = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
    world: migrateWorldDefinition(
      structuredClone(changed) as unknown as WorldDefinition,
    ),
  });
  assert.ok(await ensureStoryhavenSnapshotCurrent(currentPassedWorld));
  const playerNext = await loadStoryhavenTurnContext({
    ownerUserId: player,
    actingUserId: player,
    sessionId: other.id,
  });
  assert.ok(
    playerNext.epoch > publicCtx.epoch,
    "transaction fence also covers a creator acting in another owner session",
  );
  assert.equal(playerNext.worldHash, hash(storedLive));
  // Non-content review metadata does not invalidate memory.
  await db
    .update(worldPendingEdits)
    .set({ status: "rejected" })
    .where(eq(worldPendingEdits.worldId, world!.id));
  assert.ok(await ensureStoryhavenSnapshotCurrent(next));
  await db
    .delete(worldPendingEdits)
    .where(eq(worldPendingEdits.worldId, world!.id));
  assert.equal(await ensureStoryhavenSnapshotCurrent(next), false);
  const withoutHeld = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
  });
  assert.equal(withoutHeld.worldHash, hash(storedLive));
  // The effective gate changes when a world leaves published state, even if live schema is identical.
  await db.insert(worldPendingEdits).values({
    worldId: world!.id,
    createdBy: creator,
    groupKey: world!.id,
    schema: held,
  });
  const beforeUnpublish = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
  });
  await db
    .update(worlds)
    .set({ status: "draft" })
    .where(eq(worlds.id, world!.id));
  assert.equal(await ensureStoryhavenSnapshotCurrent(beforeUnpublish), false);
  const draft = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
  });
  assert.equal(draft.worldHash, hash(storedLive));
  assert.ok(draft.epoch > beforeUnpublish.epoch);
  // Authored UI stamps are preserved; only a migration-generated stamp is ignored.
  const authored = {
    ...live,
    version: "21.0.0",
    rootComponent: {
      id: "authored-root",
      name: "Root",
      entryFile: "index.tsx",
      files: { "index.tsx": "return null" },
      updatedAt: "2020-01-01T00:00:00Z",
    },
  };
  await db
    .update(worlds)
    .set({
      schema: {
        ...authored,
        rootComponent: {
          ...authored.rootComponent,
          updatedAt: "2021-01-01T00:00:00Z",
        },
      },
    })
    .where(eq(worlds.id, world!.id));
  const staleAuthored = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: own.id,
    world: authored as unknown as WorldDefinition,
  });
  assert.equal(
    await ensureStoryhavenSnapshotCurrent(staleAuthored),
    true,
    "renderer timestamps do not change the story supplied to memory",
  );
});

test("branch checkpoint eligibility uses the creator resolved working-copy schema", async (t) => {
  await ensureStoryhavenMemoryTables();
  t.after(async () => {
    await stopMemoryWorker();
    await closeMemoryRuntime();
  });
  const r = await getMemoryRuntime(),
    creator = crypto.randomUUID();
  await db.insert(user).values({
    id: creator,
    name: "Creator fork",
    email: `${creator}@test.local`,
  });
  const live = { name: "Live", entries: [], variables: [] },
    held = {
      name: "Held",
      entries: [],
      rootComponent: {
        id: "fork-root",
        name: "Root",
        entryFile: "index.tsx",
        files: { "index.tsx": "return null" },
        updatedAt: "2020-01-01T00:00:00Z",
      },
      variables: [
        {
          id: "draft-only",
          name: "Draft only",
          type: "number",
          defaultValue: 5,
        },
      ],
    };
  const [world] = await db
    .insert(worlds)
    .values({
      creatorId: creator,
      name: "Published fork",
      status: "published",
      schema: live,
    })
    .returning();
  const [parent] = await db
    .insert(playSessions)
    .values({
      userId: creator,
      worldId: world!.id,
      state: { variables: { "draft-only": 8 } },
    })
    .returning();
  await db.insert(worldPendingEdits).values({
    worldId: world!.id,
    createdBy: creator,
    groupKey: world!.id,
    schema: held,
  });
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET backend='storyhaven',settings='{"settleMarginExchanges":0}'::jsonb WHERE session_id=${parent!.id}`,
  );
  await db.insert(messages).values([
    {
      id: `${creator}:u`,
      sessionId: parent!.id,
      role: "user",
      content: "Creator question",
      createdAt: new Date(1000),
    },
    {
      id: `${creator}:a`,
      sessionId: parent!.id,
      role: "assistant",
      content: "Creator answer",
      createdAt: new Date(2000),
    },
  ]);
  const profile = await r.profiles.create(creator, {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "fixture",
    dimensions: 3,
  });
  await ensureProfileSchema(r.database, profile);
  await r.profiles.setStatus(creator, profile.id, "ready");
  await r.profiles.activate(creator, profile.id, profile.revision);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: creator,
    sessionId: parent!.id,
    charId: world!.id,
  };
  await ensureIdentity(r.database, scope);
  const repos = createMemoryRepositories(r.database, scope, r.key);
  await repos.facts.recordBatch("held-batch", 0, 1, 1);
  await repos.facts.insert(
    {
      text: "Working-copy checkpoint fact.",
      fact_type: "event",
      participants: [],
      importance: 3,
      valence: 0,
      turn: 1,
      batch_id: "held-batch",
    },
    [1, 0, 0],
    true,
  );
  await repos.facts.setCursor(1);
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: parent!.id,
  });
  await saveSessionSnapshot(
    r.database,
    profile,
    parent!.id,
    1,
    ctx.messages,
    r.key,
    { worldHash: memoryWorldHash(held), group: false, epoch: ctx.epoch },
  );
  const result = await branchSession({
    userId: creator,
    sessionId: parent!.id,
    messageId: `${creator}:a`,
  });
  assert.equal(result.status, 201);
  const child = await loadStoryhavenTurnContext({
    ownerUserId: creator,
    actingUserId: creator,
    sessionId: result.body.data!.sessionId,
  });
  const snap = await loadSessionSnapshot(
    r.database,
    profile,
    child.sessionId,
    1,
    child.messages,
    r.key,
    { worldHash: memoryWorldHash(held), group: false },
  );
  assert.ok(snap, "fork must inherit the eligible working-copy checkpoint");
  assert.equal(
    decryptMemoryText(String(snap.data.memory_facts[0]?.text), r.key),
    "Working-copy checkpoint fact.",
  );
});
