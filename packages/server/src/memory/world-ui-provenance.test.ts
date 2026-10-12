import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { loadStoryhavenTurnContext, ensureStoryhavenSnapshotCurrent, stopMemoryWorker } from "./yumina-adapter.js";
import { getMemoryRuntime, closeMemoryRuntime } from "./runtime.js";

test("changing the story renderer preserves memory provenance while authored lore still invalidates it", async (t) => {
  await ensureStoryhavenMemoryTables();
  await getMemoryRuntime();
  t.after(async () => { await stopMemoryWorker(); await closeMemoryRuntime(); });
  await db.execute(sql`INSERT INTO "user"(id,name,email) VALUES('ui-memory-u','Player','ui-memory@example.test')`);
  await db.execute(sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('ui-memory-w','ui-memory-u','Academy','{"name":"Academy","entries":[{"id":"lore","role":"lore","name":"Gate","content":"The gate is locked."}],"variables":[],"rootComponent":{"files":{"index.tsx":"old UI"},"updatedAt":"old"}}'::jsonb)`);
  await db.execute(sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('ui-memory-s','ui-memory-u','ui-memory-w')`);
  await db.execute(sql`INSERT INTO messages(id,session_id,role,content,created_at) VALUES('ui-memory-m1','ui-memory-s','user','Open the gate.','2020-01-01'),('ui-memory-m2','ui-memory-s','assistant','It remains locked.','2020-01-02')`);
  const load = () => loadStoryhavenTurnContext({ownerUserId:'ui-memory-u',actingUserId:'ui-memory-u',sessionId:'ui-memory-s'});
  const before = await load();
  await db.execute(sql`UPDATE worlds SET schema=jsonb_set(schema,'{rootComponent}','{"files":{"index.tsx":"new styled UI"},"updatedAt":"new"}'::jsonb) WHERE id='ui-memory-w'`);
  const afterUi = await load();
  assert.equal(afterUi.epoch, before.epoch, "renderer edits must not schedule a destructive memory rebuild");
  assert.equal(afterUi.worldHash, before.worldHash, "accepted memory snapshots must survive renderer edits");
  assert.equal(await ensureStoryhavenSnapshotCurrent(before), true);
  await db.execute(sql`UPDATE worlds SET schema=jsonb_set(schema,'{entries,0,content}','"The gate is open."'::jsonb) WHERE id='ui-memory-w'`);
  const afterLore = await load();
  assert.ok(afterLore.epoch > afterUi.epoch);
  assert.notEqual(afterLore.worldHash, afterUi.worldHash);
  assert.equal(await ensureStoryhavenSnapshotCurrent(afterUi), false);
});
