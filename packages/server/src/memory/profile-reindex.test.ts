import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
  quoteSchema,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { encryptMemoryText } from "./crypto.js";
import { reindexProfile } from "./profile-reindex.js";

test("profile migration copies canonical lineage without extraction", async () => {
  const db = await createMemoryDatabase();
  const key = new Uint8Array(32).fill(7);
  const repo = new ProfileRepository(db, {
    encrypt: (s) => s,
    decrypt: (s) => s,
  });
  try {
    await ensureRegistry(db);
    const old = await repo.create("u", {
      baseUrl: "http://localhost",
      model: "old",
      dimensions: 3,
    });
    const target = await repo.create("u", {
      baseUrl: "http://localhost",
      model: "new",
      dimensions: 4,
    });
    for (const p of [old, target]) await ensureProfileSchema(db, p);
    await ensureIdentity(db, {
      profileId: old.id,
      schemaName: old.schemaName,
      ownerUserId: "u",
      sessionId: "s",
      charId: "c",
    });
    const s = quoteSchema(old.schemaName);
    await db.query(
      `INSERT INTO ${s}.memory_facts(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,last_turn,created_ts,embedding) VALUES('f','s','c',$1,'promise','{}',4,1,2,1,3,1,'[1,0,0]')`,
      [encryptMemoryText("A promise", key)],
    );
    // Historical recall mirrors may exist while migration prepares vectors.
    await db.query(
      `INSERT INTO ${s}.sessions(id,user_id,char_id) VALUES('snapshot:preview','u','c')`,
    );
    await db.query(
      `INSERT INTO ${s}.memory_facts SELECT 'preview-fact','snapshot:preview',char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,valid_until_turn,last_turn,created_ts,expired_ts,superseded_by,pinned,location,batch_id,embedding FROM ${s}.memory_facts WHERE id='f'`,
    );
    await repo.setStatus("u", old.id, "ready");
    await repo.activate("u", old.id, old.revision);
    let calls = 0;
    await reindexProfile({
      db,
      profiles: repo,
      ownerUserId: "u",
      source: old,
      target,
      key,
      embedding: {
        embed: async (text) => {
          assert.equal(text, "A promise");
          calls++;
          await db.query(
            `DELETE FROM ${s}.memory_facts WHERE session_id='snapshot:preview'`,
          );
          await db.query(
            `DELETE FROM ${s}.sessions WHERE id='snapshot:preview'`,
          );
          return [1, 0, 0, 0];
        },
        embedQuery: async () => {
          throw new Error("query not used");
        },
      },
    });
    assert.equal(calls, 1);
    const r = await db.query(
      `SELECT reinforcements,embedding::text AS embedding FROM ${quoteSchema(target.schemaName)}.memory_facts`,
    );
    assert.equal(r.rows[0]?.reinforcements, 2);
    assert.equal(r.rows.length, 1);
    assert.equal(
      (
        await db.query(
          `SELECT id FROM ${quoteSchema(target.schemaName)}.sessions WHERE id LIKE 'snapshot:%'`,
        )
      ).rows.length,
      0,
    );
    assert.equal(JSON.parse(r.rows[0]!.embedding as string).length, 4);
    assert.equal((await repo.getActive("u"))?.id, target.id);
  } finally {
    await db.close();
  }
});

test("profile migration rejects a source mutation while embedding and retains active pointer", async () => {
  const db = await createMemoryDatabase();
  const key = new Uint8Array(32).fill(7);
  const repo = new ProfileRepository(db, {
    encrypt: (s) => s,
    decrypt: (s) => s,
  });
  try {
    await ensureRegistry(db);
    const source = await repo.create("u", {
      baseUrl: "http://localhost",
      model: "a",
      dimensions: 2,
    });
    const target = await repo.create("u", {
      baseUrl: "http://localhost",
      model: "b",
      dimensions: 3,
    });
    for (const p of [source, target]) await ensureProfileSchema(db, p);
    await ensureIdentity(db, {
      profileId: source.id,
      schemaName: source.schemaName,
      ownerUserId: "u",
      sessionId: "s",
      charId: "c",
    });
    const s = quoteSchema(source.schemaName);
    await db.query(
      `INSERT INTO ${s}.memory_facts(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,last_turn,created_ts) VALUES('f','s','c',$1,'event','{}',3,0,0,1,1,1)`,
      [encryptMemoryText("Past", key)],
    );
    await repo.setStatus("u", source.id, "ready");
    await repo.activate("u", source.id, source.revision);
    await assert.rejects(
      reindexProfile({
        db,
        profiles: repo,
        ownerUserId: "u",
        source,
        target,
        key,
        embedding: {
          embed: async () => {
            await db.query(`UPDATE ${s}.memory_facts SET reinforcements=1`);
            return [1, 0, 0];
          },
          embedQuery: async () => [],
        },
      }),
      /memory_source_changed/,
    );
    assert.equal((await repo.getActive("u"))?.id, source.id);
    assert.equal((await repo.get("u", target.id))?.status, "failed");
  } finally {
    await db.close();
  }
});
