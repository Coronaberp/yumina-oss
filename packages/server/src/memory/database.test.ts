import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDatabase } from "./database.js";
test("independent memory DB persists and transactions roll back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yumina-memory-"));
  try {
    let db = await createMemoryDatabase({ dataDir: dir });
    await db.query("CREATE TABLE persistence(value integer)");
    await db.query("INSERT INTO persistence VALUES(7)");
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO persistence VALUES(8)");
        throw new Error("abort");
      }),
    );
    await db.close();
    db = await createMemoryDatabase({ dataDir: dir });
    assert.deepEqual((await db.query("SELECT value FROM persistence")).rows, [
      { value: 7 },
    ]);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("nested transactions roll back only savepoint then outer failure rolls back all", async () => {
  const db = await createMemoryDatabase();
  try {
    await db.query("CREATE TABLE nested(value integer)");
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO nested VALUES(1)");
        await assert.rejects(() =>
          tx.transaction(async (inner) => {
            await inner.query("INSERT INTO nested VALUES(2)");
            throw new Error("inner");
          }),
        );
        assert.deepEqual((await tx.query("SELECT value FROM nested")).rows, [
          { value: 1 },
        ]);
        await tx.transaction(async (inner) => {
          await inner.query("INSERT INTO nested VALUES(3)");
        });
        throw new Error("outer");
      }),
    );
    assert.deepEqual((await db.query("SELECT value FROM nested")).rows, []);
  } finally {
    await db.close();
  }
});
