import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import { ensureRegistry, ensureProfileSchema } from "./schema.js";
import { ProfileRepository } from "./profiles.js";
test("original profile schemas isolate owner/model and allow exact vectors above HNSW limit", async () => {
  const db = await createMemoryDatabase({ dataDir: "memory://" });
  await ensureRegistry(db);
  const repo = new ProfileRepository(db, {
    encrypt: (s) => `encrypted:${s}`,
    decrypt: (s) => s.slice(10),
  });
  const a = await repo.create("alice", {
    baseUrl: "http://localhost:8000/v1",
    model: "a",
    dimensions: 1024,
    apiKey: "secret",
  });
  const b = await repo.create("bob", {
    baseUrl: "http://localhost:8001/v1",
    model: "b",
    dimensions: 3072,
  });
  await ensureProfileSchema(db, a);
  await ensureProfileSchema(db, b);
  assert.notEqual(a.schemaName, b.schemaName);
  assert.match(a.schemaName, /^shm_[a-f0-9]{32}$/);
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    "SELECT column_name,udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [a.schemaName, "memory_facts"],
  );
  assert.ok(
    cols.rows.some(
      (c) => c.column_name === "embedding" && c.udt_name === "vector",
    ),
  );
  const idx = await db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname=$1",
    [b.schemaName],
  );
  assert.ok(idx.rows.every((i) => !i.indexdef.includes("hnsw")));
  for (const name of [
    "memory_reinforce_log_fact_id_idx",
    "memory_reinforce_log_batch_id_idx",
    "memory_cluster_items_cluster_id_idx",
    "memory_cluster_items_fact_id_idx",
  ])
    assert.ok(idx.rows.some((i) => i.indexdef.includes(name)));
  const result = await db.query<{ distance: number }>(
    `SELECT $1::vector <=> $2::vector AS distance`,
    [JSON.stringify(Array(3072).fill(1)), JSON.stringify(Array(3072).fill(1))],
  );
  assert.ok(Math.abs(result.rows[0]!.distance) < 1e-6);
  assert.equal(await repo.get("bob", a.id), null);
  await assert.rejects(() => repo.activate("bob", a.id, 1));
  await repo.setStatus("alice", a.id, "ready");
  await repo.activate("alice", a.id, 1);
  assert.equal((await repo.getActive("alice"))!.id, a.id);
  assert.equal(await repo.getCredential("alice", a.id), "secret");
  const raw = await db.query<{ credential: string }>(
    "SELECT credential FROM memory_registry.profiles WHERE id=$1",
    [a.id],
  );
  assert.equal(raw.rows[0]!.credential, "encrypted:secret");
  await assert.rejects(() =>
    repo.create("alice", { baseUrl: "x", model: "a", dimensions: 16001 }),
  );
  await assert.rejects(() =>
    ensureProfileSchema(db, { ...a, schemaName: "public; DROP SCHEMA public" }),
  );
  await db.close();
});
