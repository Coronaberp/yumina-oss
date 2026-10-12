import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";

test("all history mutations write durable epochs and deletion survives session cascade", async () => {
  await ensureTables();
  await db.execute(
    sql`INSERT INTO "user"(id,name,email) VALUES('memory-owner','Owner','memory-owner@example.test')`,
  );
  await db.execute(
    sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('memory-world','memory-owner','Test','{}')`,
  );
  await db.execute(
    sql`INSERT INTO play_sessions(id,user_id,world_id,state) VALUES('memory-session','memory-owner','memory-world','{}')`,
  );
  await db.execute(
    sql`INSERT INTO messages(id,session_id,role,content) VALUES('memory-message','memory-session','user','first')`,
  );
  await db.execute(
    sql`UPDATE messages SET content='edited' WHERE id='memory-message'`,
  );
  const before = await db.execute(
    sql`SELECT kind,epoch FROM storyhaven_memory_outbox WHERE session_id='memory-session' ORDER BY id`,
  );
  assert.deepEqual(
    before.rows.map((r) => r.kind),
    ["append", "invalidate"],
  );
  assert.deepEqual(
    before.rows.map((r) => Number(r.epoch)),
    [0, 1],
  );
  await db.execute(sql`DELETE FROM play_sessions WHERE id='memory-session'`);
  const after = await db.execute(
    sql`SELECT kind FROM storyhaven_memory_outbox WHERE session_id='memory-session' ORDER BY id`,
  );
  assert.equal(after.rows.at(-1)?.kind, "purge");
});
