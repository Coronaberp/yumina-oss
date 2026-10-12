import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import { ensureRegistry, ensureProfileSchema, ensureIdentity, validateScope, quoteSchema } from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { publicEmbeddingProfile } from "./profile-input.js";
import { encryptMemoryText } from "./crypto.js";
import { reindexProfile } from "./profile-reindex.js";

test("admin embedding default gives users private owned profiles and encrypted credentials", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  try {
    await ensureRegistry(db);
    const cipher = { encrypt: (v: string) => `encrypted:${v}`, decrypt: (v: string) => v.slice(10) };
    let sourceAvailable = true;
    const repo: ProfileRepository = new ProfileRepository(db, cipher, {
      source: async reader => sourceAvailable ? repo.getOwnActive("admin", reader) : null,
      prepare: p => ensureProfileSchema(db, p),
    });
    const admin = await repo.create("admin", { baseUrl: "http://admin-only/v1", model: "admin-embedding", dimensions: 3, apiKey: "admin-secret" });
    await ensureProfileSchema(db, admin);
    await repo.setStatus("admin", admin.id, "ready");
    await repo.activate("admin", admin.id, admin.revision);
    const [alice, aliceAgain, bob] = await Promise.all([repo.getActive("alice"), repo.getActive("alice"), repo.getActive("bob")]);
    assert.ok(alice && bob && aliceAgain);
    assert.equal(alice.userId, "alice");
    assert.equal(alice.inheritedFrom, admin.id);
    assert.equal(alice.id, aliceAgain.id);
    assert.notEqual(alice.schemaName, bob.schemaName);
    assert.notEqual(alice.schemaName, admin.schemaName);
    assert.equal(await repo.getCredential("alice", alice.id), "admin-secret");
    const raw = (await db.query("SELECT credential FROM memory_registry.profiles WHERE id=$1", [alice.id])).rows[0]!;
    assert.equal(raw.credential, "encrypted:admin-secret");
    const dto = publicEmbeddingProfile(alice, true);
    assert.equal(dto.configurationSource, "admin");
    assert.equal(dto.baseUrl, "");
    assert.equal(dto.hasKey, false);
    assert.equal(JSON.stringify(dto).includes("admin-secret"), false);
    assert.equal(JSON.stringify(dto).includes(admin.id), false);
    await assert.rejects(() => repo.updateKey("alice", alice.id, "replacement"), /admin/i);
    const scope = { profileId: alice.id, schemaName: alice.schemaName, ownerUserId: "alice", sessionId: "alice-session", charId: "world" };
    await ensureIdentity(db, scope);
    await validateScope(db, scope);
    await assert.rejects(() => validateScope(db, { ...scope, ownerUserId: "bob" }));

    const draft = await repo.create("alice", { baseUrl: "http://personal/v1", model: "draft", dimensions: 3 });
    await repo.setStatus("alice", draft.id, "failed");
    assert.equal((await repo.getActive("alice"))!.id, alice.id);
    await repo.setStatus("alice", draft.id, "ready");
    await repo.activate("alice", draft.id, draft.revision);
    assert.equal((await repo.getActive("alice"))!.id, draft.id);
    assert.equal(await repo.isActiveInheritedSource(alice), false, "A stale admin-default update cannot override a newly activated personal profile");
    await repo.setStatus("alice", draft.id, "failed");
    assert.equal((await repo.getActive("alice"))!.id, draft.id, "An explicitly activated personal profile remains the user override");

    await repo.updateKey("admin", admin.id, "rotated-secret");
    const rotated = await repo.getActive("bob");
    assert.equal(rotated!.id, bob.id);
    assert.equal(await repo.getCredential("bob", bob.id), "rotated-secret");
    const next = await repo.create("admin", { baseUrl: "http://next/v1", model: "new-vector-space", dimensions: 4 });
    await ensureProfileSchema(db, next);
    await repo.setStatus("admin", next.id, "ready");
    await repo.activate("admin", next.id, next.revision);
    const unchanged = await repo.getActive("bob");
    assert.equal(unchanged!.id, bob.id);
    assert.equal(unchanged!.dimensions, 3, "A changed vector space must not rewrite existing storage");
    assert.equal(unchanged!.adminDefaultUpdateAvailable, true);
    const target = await repo.prepareAdminDefault("bob");
    assert.equal(target!.userId, "bob");
    assert.equal(target!.dimensions, 4);
    assert.notEqual(target!.schemaName, bob.schemaName);
    assert.equal((await repo.getOwnActive("bob"))!.id, bob.id, "Preparing a target never switches away before reindex succeeds");
    await repo.setStatus("bob", target!.id, "failed");
    await repo.updateKey("admin", next.id, "retry-key");
    const retry = await repo.prepareAdminDefault("bob");
    assert.equal(retry!.id, target!.id);
    assert.equal(await repo.getCredential("bob", retry!.id), "retry-key");
    assert.equal(await repo.inheritedSourceCurrent(retry!), true);
    const withinTransaction = await db.transaction(tx => repo.inheritedSourceCurrent(retry!, tx));
    assert.equal(withinTransaction, true);
    const key = new Uint8Array(32).fill(7);
    await ensureIdentity(db, { profileId: bob.id, schemaName: bob.schemaName, ownerUserId: "bob", sessionId: "bob-session", charId: "world" });
    await db.query(`INSERT INTO ${quoteSchema(bob.schemaName)}.memory_facts(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,last_turn,created_ts) VALUES('bob-fact','bob-session','world',$1,'event','{}',3,0,0,1,1,1)`, [encryptMemoryText("Bob's private promise", key)]);
    let transactionChecks = 0;
    await reindexProfile({ db, profiles: repo, ownerUserId: "bob", source: bob, target: retry!, key,
      ensureCurrent: async reader => {
        if (reader) transactionChecks++;
        return await repo.isActiveInheritedSource(bob, reader) && await repo.inheritedSourceCurrent(retry!, reader);
      },
      embedding: { embed: async text => { assert.equal(text, "Bob's private promise"); return [1, 0, 0, 0]; }, embedQuery: async () => [] },
    });
    assert.ok(transactionChecks >= 2, "Migration pins the source inside its commit transaction without deadlocking PGlite");
    assert.equal((await repo.getActive("bob"))!.id, retry!.id);
    assert.equal((await db.query(`SELECT id FROM ${quoteSchema(retry!.schemaName)}.memory_facts`)).rows[0]!.id, "bob-fact");
    assert.equal((await db.query(`SELECT count(*) AS count FROM ${quoteSchema(alice.schemaName)}.memory_facts`)).rows[0]!.count, 0);
    sourceAvailable = false;
    assert.equal(await repo.getActive("bob"), null, "A withdrawn admin source stops inherited calls without deleting memory");
    assert.ok(await repo.get("bob", bob.id));
    assert.equal((await repo.getOwnActive("bob"))!.id, retry!.id, "Storage-only forks retain their profile while the provider is unavailable");
    assert.equal((await repo.getActive("alice"))!.id, draft.id, "The user's personal configuration is independent of admin availability");
  } finally { await db.close(); }
});
