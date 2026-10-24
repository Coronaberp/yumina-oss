import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveUploadStore, ARCHIVE_UPLOAD_CHUNK_BYTES } from "./archive-upload-store.js";
const id = "1a197984-28be-4014-a972-23e5c5826e14";
const result = { sessionId: "restored", worldId: "new-card" };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "archive-upload-test-")); return { root, store: new ArchiveUploadStore(root), close: () => rm(root, { recursive: true, force: true }) }; }
test("private staging restores all chunk bytes once and survives store recreation", async () => {
  const f = await fixture();
  try {
    const payload = Buffer.from('{"assets":"' + "a".repeat(ARCHIVE_UPLOAD_CHUNK_BYTES + 17) + '"}');
    await f.store.create("owner", id, payload.length, "preview");
    await f.store.append("owner", id, 0, payload.subarray(0, ARCHIVE_UPLOAD_CHUNK_BYTES));
    const resumed = new ArchiveUploadStore(f.root);
    assert.equal((await resumed.status("owner", id)).receivedBytes, ARCHIVE_UPLOAD_CHUNK_BYTES);
    await resumed.append("owner", id, ARCHIVE_UPLOAD_CHUNK_BYTES, payload.subarray(ARCHIVE_UPLOAD_CHUNK_BYTES));
    let restores = 0;
    const restore = async (json: string, context?: string) => { restores++; assert.equal(json, payload.toString()); assert.equal(context, "preview"); return result; };
    assert.deepEqual(await resumed.complete("owner", id, restore), result);
    assert.deepEqual(await new ArchiveUploadStore(f.root).complete("owner", id, restore), result);
    assert.equal(restores, 1);
  } finally { await f.close(); }
});
test("replayed chunks are acknowledged without appending twice; wrong bytes and offsets are rejected", async () => {
  const f = await fixture();
  try {
    await f.store.create("owner", id, 6);
    await f.store.append("owner", id, 0, Buffer.from("abc"));
    assert.equal((await f.store.append("owner", id, 0, Buffer.from("abc"))).receivedBytes, 3);
    await assert.rejects(f.store.append("owner", id, 0, Buffer.from("xyz")), /match|differ|conflict/i);
    await assert.rejects(f.store.append("owner", id, 4, Buffer.from("xy")), /position|offset/i);
    await assert.rejects(f.store.complete("owner", id, async () => result), /complete|finish/i);
    await f.store.append("owner", id, 3, Buffer.from("def"));
    await f.store.complete("owner", id, async json => { assert.equal(json, "abcdef"); return result; });
  } finally { await f.close(); }
});
test("ownership, path, size and immutable upload metadata stay bounded", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.create("owner", "../escape", 1), /identifier|ID/i);
    await assert.rejects(f.store.create("owner", id, 512 * 1024 * 1024 + 1), /size|large|512/i);
    await f.store.create("owner", id, 5, "preview");
    await assert.rejects(f.store.status("other", id), /not found/i);
    await assert.rejects(f.store.create("owner", id, 5, "different-preview"), /match|conflict/i);
    await assert.rejects(f.store.append("owner", id, 0, Buffer.alloc(ARCHIVE_UPLOAD_CHUNK_BYTES + 1)), /chunk|large/i);
    assert.equal((await f.store.status("owner", id)).receivedBytes, 0);
  } finally { await f.close(); }
});
test("only one finalize runs at a time and a failed transaction can resume the same attempt", async () => {
  const f = await fixture();
  try {
    await f.store.create("owner", id, 2); await f.store.append("owner", id, 0, Buffer.from("{}"));
    await assert.rejects(f.store.complete("owner", id, async () => { throw new Error("Transaction rolled back"); }), /rolled back/);
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const pending = f.store.complete("owner", id, async () => { entered(); await held; return result; });
    await started;
    await assert.rejects(f.store.complete("owner", id, async () => { throw new Error("Duplicate restore"); }), /running|progress|busy/i);
    finish(); assert.deepEqual(await pending, result);
    assert.deepEqual((await f.store.status("owner", id)).result, result);
  } finally { await f.close(); }
});
