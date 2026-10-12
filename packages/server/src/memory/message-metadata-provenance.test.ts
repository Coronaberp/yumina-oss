import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { loadStoryhavenTurnContext, ensureStoryhavenSnapshotCurrent, stopMemoryWorker } from "./yumina-adapter.js";
import { getMemoryRuntime, closeMemoryRuntime } from "./runtime.js";

test("credit receipts on appended replies preserve an in-flight memory prefix while story edits invalidate it", async (t) => {
  await ensureStoryhavenMemoryTables();
  await getMemoryRuntime();
  t.after(async () => { await stopMemoryWorker(); await closeMemoryRuntime(); });
  await db.execute(sql`INSERT INTO "user"(id,name,email) VALUES('receipt-u','Player','receipt@example.test')`);
  await db.execute(sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('receipt-w','receipt-u','Academy','{"name":"Academy","entries":[],"variables":[]}'::jsonb)`);
  await db.execute(sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('receipt-s','receipt-u','receipt-w')`);
  await db.execute(sql`INSERT INTO messages(id,session_id,role,content,created_at) VALUES('receipt-u1','receipt-s','user','Store the violet astrolabe.','2020-01-01'),('receipt-a1','receipt-s','assistant','Sera stores it in the north observatory.','2020-01-02')`);
  const load = () => loadStoryhavenTurnContext({ownerUserId:'receipt-u',actingUserId:'receipt-u',sessionId:'receipt-s'});
  const extracting = await load();
  await db.execute(sql`INSERT INTO messages(id,session_id,role,content,swipes,created_at) VALUES('receipt-u2','receipt-s','user','Check the lantern.','[]'::jsonb,'2020-01-03'),('receipt-a2','receipt-s','assistant','The lantern is intact.','[{"content":"The lantern is intact.","choices":["Inspect it"]}]'::jsonb,'2020-01-04')`);
  await db.execute(sql`UPDATE messages SET swipes=jsonb_set(jsonb_set(swipes,'{0,creditCost}','0'::jsonb),'{0,creditBalanceAfter}','100'::jsonb) WHERE id='receipt-a2'`);
  assert.equal((await load()).epoch, extracting.epoch, "a normal credit receipt must not cancel a previous extraction");
  assert.equal(await ensureStoryhavenSnapshotCurrent(extracting), true, "new complete turns must preserve the settled prefix");
  const accepted = await load();
  await db.execute(sql`UPDATE messages SET swipes=jsonb_set(swipes,'{0,choices}','["Break it"]'::jsonb) WHERE id='receipt-a2'`);
  assert.ok((await load()).epoch > accepted.epoch);
  assert.equal(await ensureStoryhavenSnapshotCurrent(accepted), false);
});
