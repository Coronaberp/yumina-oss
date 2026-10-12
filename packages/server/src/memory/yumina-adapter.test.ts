import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import {
  loadStoryhavenTurnContext,
  ensureStoryhavenSnapshotCurrent,
} from "./yumina-adapter.js";

test("history adapter loads compacted history, selects a historical prefix, and rejects owner mismatch and concurrent edits", async () => {
  await ensureTables();
  await db.execute(
    sql`INSERT INTO "user"(id,name,email) VALUES('adapter-u','Player','adapter@example.test')`,
  );
  await db.execute(
    sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('adapter-w','adapter-u','Mira','{"name":"Mira","entries":[],"variables":[]}')`,
  );
  await db.execute(
    sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('adapter-s','adapter-u','adapter-w')`,
  );
  await db.execute(
    sql`INSERT INTO messages(id,session_id,role,content,created_at,compacted) VALUES('m1','adapter-s','user','past','2020-01-01',true),('m2','adapter-s','assistant','reply','2020-01-02',true),('m3','adapter-s','user','future','2020-01-03',false)`,
  );
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: "adapter-u",
    actingUserId: "adapter-u",
    sessionId: "adapter-s",
    cutoffMessageId: "m2",
  });
  assert.deepEqual(
    ctx.messages.map((r) => r.id),
    ["m1"],
  );
  assert.equal(ctx.query, "past");
  assert.equal(await ensureStoryhavenSnapshotCurrent(ctx), true);
  await db.execute(sql`UPDATE "user" SET preferences='{"aiConfig":{"memoryBudgetTokens":4096}}'::jsonb WHERE id='adapter-u'`);
  const inherited = await loadStoryhavenTurnContext({ ownerUserId: "adapter-u", actingUserId: "adapter-u", sessionId: "adapter-s", cutoffMessageId: "m2" });
  assert.equal(inherited.defaultMemoryBudgetTokens, 4096);
  assert.equal(inherited.settings.memoryBudgetTokens, undefined);
  await assert.rejects(
    loadStoryhavenTurnContext({
      ownerUserId: "foreign",
      actingUserId: "foreign",
      sessionId: "adapter-s",
    }),
  );
  await db.execute(sql`UPDATE messages SET content='edited' WHERE id='m1'`);
  assert.equal(await ensureStoryhavenSnapshotCurrent(ctx), false);
});
