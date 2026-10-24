import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assets, messages, playSessions, user, userPersonas, worlds } from "../db/schema.js";
import { STORAGE_DIR } from "../lib/env.js";
import { getObjectBuffer } from "../lib/s3.js";
import { exportSessionArchive, importSessionArchive } from "./session-archives.js";

const stamp = "2026-10-13T01:00:00.000Z";
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
after(async () => { if ("close" in db.$client && !db.$client.closed) await db.$client.close(); });

test("transcript export reads display fields and the active speaker without loading snapshots or inactive swipes", async t => {
  const owner = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Projection fixture", email: `${owner}@test.invalid` });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Projection", schema: { entries: [], variables: [] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `projection-${owner}-${i}`, sessionId: session!.id, role: "assistant" as const, content: `Visible ${i}`, createdAt: new Date(stamp),
    stateSnapshot: { payload: "SNAPSHOT_UNNEEDED".repeat(2000) }, activeSwipeIndex: 1,
    swipes: [{ content: "INACTIVE_UNNEEDED".repeat(2000), rawContent: "INACTIVE_UNNEEDED".repeat(2000), createdAt: stamp },
      { content: `Visible ${i}`, rawContent: `  [\u200bsPeAkEr:海里 ${i}:happy] Visible ${i}`, createdAt: stamp }] }));
  await db.insert(messages).values(rows);
  const captured: Array<{ sql: string; rows: unknown[] }> = [];
  const original = db.$client.query;
  t.mock.method(db.$client, "query", async (...args: unknown[]) => {
    const result = await Reflect.apply(original, db.$client, args);
    if (typeof args[0] === "string" && /from "messages"/i.test(args[0])) captured.push({ sql: args[0], rows: result.rows });
    return result;
  });
  const transcript = await exportSessionArchive(owner, session!.id, "transcript");
  assert.deepEqual(transcript.messages.map(m => [m.content, m.presentationSpeaker]), rows.map((m, i) => [m.content, `海里 ${i}`]));
  assert.equal(captured.length, 1);
  const projected = JSON.stringify(captured[0]!.rows);
  assert.equal(/SNAPSHOT_UNNEEDED|INACTIVE_UNNEEDED/.test(projected), false, "transcript query must not materialize snapshots or inactive bodies");
  const full = await exportSessionArchive(owner, session!.id, "full-save");
  const before = Buffer.byteLength(JSON.stringify(captured[1]!.rows)), after = Buffer.byteLength(projected);
  assert.ok(after < before / 10, "projected query payload excludes unused saved-state and swipe bodies");
  assert.deepEqual(full.messages[0]!.stateSnapshot, rows[0]!.stateSnapshot);
  assert.equal(full.messages[0]!.swipes!.length, 2);
  console.log(JSON.stringify({ proxy: "serialized driver-result rows, not wire transfer or process memory", completeRowsBytes: before, transcriptQueryRowsBytes: after, messages: 7 }));
});

function archiveFixture(keys: string[], media: Record<string, string>, profileId?: string) {
  return { format: "yumina-chat", version: 1, mode: "full-save", exportedAt: stamp,
    session: { id: "source-session", name: "Archive allocation fixture", createdAt: stamp, updatedAt: stamp },
    world: { id: "source-world", name: "Archive fixture", description: "Synthetic archive", schema: { entries: [], variables: [], media: keys } },
    player: { name: "Saved player", avatar: null }, participants: [], display: [], assets: media,
    messages: Array.from({ length: 7 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? "user" : "assistant", content: `Saved message ${i}`, createdAt: stamp })),
    restore: { state: { worldId: "source-world", turnCount: 15, variables: { energy: 95, relationship: 53 } },
      persona: { persona: { ...(profileId ? { id: profileId } : {}), name: "Saved player", backstory: "Captured continuity" }, ...(profileId ? { selection: { kind: "player", id: profileId } } : {}), selectionVersion: "source-version", started: true },
      settings: { sessionMemoryPinned: "Keep the promise" }, checkpoints: [], memories: [], snippets: [], continuityNotes: [] } };
}

test("107-asset full save decodes one upload at a time and preserves hashes, messages, persona, state and durable retry", async t => {
  const owner = crypto.randomUUID(), sessionId = crypto.randomUUID(), worldId = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Asset fixture", email: `${owner}@test.invalid` });
  const [profile] = await db.insert(userPersonas).values({ userId: owner, name: "Current player", backstory: "Current profile", note: "PRIVATE" }).returning();
  const media: Record<string, string> = {}, expected = new Map<string, string>(), base64s = new Set<string>();
  const sizes: number[] = [];
  for (let i = 0; i < 107; i++) {
    const bytes = Buffer.alloc(128 + i, i), key = `@asset:12345678-${i}`, base64 = bytes.toString("base64");
    media[key] = `data:image/png;base64,${base64}`; expected.set(key, hash(bytes)); base64s.add(base64); sizes.push(bytes.length);
  }
  media["/vn-assets/duplicate.png"] = media["@asset:12345678-0"]!;
  const archive = archiveFixture(Object.keys(media), media, profile!.id);
  let initialDecoded = 0, decodes = 0;
  const destination = join(STORAGE_DIR, "users", owner, "image-masters", "public");
  const original = Buffer.from;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[1] === "base64" && base64s.has(args[0])) {
      decodes++;
      if (!existsSync(destination) || readdirSync(destination).length === 0) initialDecoded++;
    }
    return Reflect.apply(original, Buffer, args);
  });
  const restored = await importSessionArchive(owner, archive, { sessionId, worldId });
  assert.equal(initialDecoded, 1, "only the first asset is decoded before its upload starts");
  assert.equal(decodes, 107, "deduplication retains one decode per unique asset");
  const stored = await db.select().from(assets).where(eq(assets.worldId, worldId));
  assert.equal(stored.length, 107); assert.equal(stored.reduce((total, asset) => total + asset.sizeBytes!, 0), sizes.reduce((a, b) => a + b, 0));
  const pendingHashes = new Set(expected.values());
  for (const asset of stored) assert.ok(pendingHashes.delete(hash((await getObjectBuffer(asset.url)).buffer)));
  assert.equal(pendingHashes.size, 0);
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
  assert.deepEqual(session!.state, { ...archive.restore.state, worldId });
  assert.equal(session!.sessionMemoryPinned, "Keep the promise");
  assert.equal(session!.sessionPersona!.persona!.id, profile!.id);
  assert.equal(session!.sessionPersona!.persona!.backstory, "Captured continuity");
  assert.notEqual(session!.sessionPersona!.selectionVersion, "source-version");
  assert.ok(!JSON.stringify(session!.sessionPersona).includes("PRIVATE"));
  const imported = await db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
  assert.deepEqual(imported.map(m => m.content), archive.messages.map(m => m.content));
  const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
  const refs = world!.schema.media as string[];
  assert.equal(refs.length, 108); assert.equal(refs[107]!.split("/").at(-1), refs[0]!.slice("@asset:".length), "URL and asset-ref aliases point to the same deduplicated asset");
  assert.deepEqual(await importSessionArchive(owner, archive, { sessionId, worldId }), restored);
  assert.equal(decodes, 107, "a committed retry reuses the imported session without writing assets again");
  const second = await importSessionArchive(owner, archive);
  const siblings = await db.select().from(assets).where(eq(assets.worldId, second.worldId));
  assert.equal(siblings.length, 107);
  assert.deepEqual(new Set(siblings.map(a => a.url)), new Set(stored.map(a => a.url)), "independent imports reuse owner-scoped physical originals");
  assert.equal(new Set([...stored, ...siblings].map(a => a.id)).size, 214, "logical references stay independent");
  console.log(JSON.stringify({ proxy: "decoded asset Buffers retained by staging, not measured RSS", uniqueAssets: 107, beforeRetainedDecodedBytes: sizes.reduce((a, b) => a + b, 0), afterMaxDecodedUploadBytes: Math.max(...sizes), decodedBeforeFirstUpload: initialDecoded, messages: 7 }));
});

test("failed full-save transaction removes staged assets and leaves no imported session", async () => {
  const owner = crypto.randomUUID(), sessionId = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Rollback fixture", email: `${owner}@test.invalid` });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Existing", schema: { entries: [] } }).returning();
  const media = { "@asset:12345678-one": "data:image/png;base64,aGVsbG8=", "@asset:12345678-two": "data:image/png;base64,d29ybGQ=" };
  await assert.rejects(importSessionArchive(owner, archiveFixture(Object.keys(media), media), { sessionId, worldId: world!.id }));
  const folder = join(STORAGE_DIR, "users", owner, "archives", sessionId);
  assert.ok(!existsSync(folder) || readdirSync(folder).length === 0);
  assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, sessionId))).length, 0);
  assert.equal((await db.select().from(assets).where(eq(assets.worldId, world!.id))).length, 0);
});

test("lazy asset size validation retains accepted padding variants and rejects empty decodes before upload", async () => {
  const owner = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Base64 fixture", email: `${owner}@test.invalid` });
  const encodings = ["YQ", "YQ=", "YQ==", "YWI", "YWJj", "YWJjZ", "YWJjZ=", "YWJjZA=="];
  const media = Object.fromEntries(encodings.map((value, i) => [`@asset:12345678-padding-${i}`, `data:image/png;base64,${value}`]));
  const imported = await importSessionArchive(owner, archiveFixture(Object.keys(media), media));
  const stored = await db.select().from(assets).where(eq(assets.worldId, imported.worldId));
  assert.equal(stored.length, encodings.length);
  const expected = encodings.map(value => [Buffer.from(value, "base64").length, hash(Buffer.from(value, "base64"))].join(":"));
  for (const asset of stored) {
    const bytes = await readFile(join(STORAGE_DIR, asset.url));
    const index = expected.indexOf([asset.sizeBytes, hash(bytes)].join(":"));
    assert.ok(index >= 0); expected.splice(index, 1);
  }
  assert.equal(expected.length, 0);
  for (const value of ["", "a", "a=", "a=="]) {
    const sessionId = crypto.randomUUID(), invalid = { "@asset:12345678-invalid": `data:image/png;base64,${value}` };
    await assert.rejects(importSessionArchive(owner, archiveFixture(Object.keys(invalid), invalid), { sessionId, worldId: crypto.randomUUID() }), /empty|100 MB/);
    assert.ok(!existsSync(join(STORAGE_DIR, "users", owner, "archives", sessionId)));
  }
});

test("transcript speaker projection preserves nullable and out-of-range selected-swipe semantics", async () => {
  const owner = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Selected swipe fixture", email: `${owner}@test.invalid` });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Selected swipe", schema: { entries: [] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id }).returning();
  const indices = [null, 0, 1, -1, 9];
  await db.insert(messages).values(indices.map((index, i) => ({ id: `${owner}-${i}`, sessionId: session!.id, role: "assistant" as const, content: `Visible ${i}`, createdAt: new Date(stamp), activeSwipeIndex: index,
    swipes: [{ content: "First", rawContent: "[SPEAKER:Alpha:normal] First", createdAt: stamp }, { content: "Second", rawContent: "[SPEAKER:Beta:normal] Second", createdAt: stamp }] })));
  const exported = await exportSessionArchive(owner, session!.id, "transcript");
  assert.deepEqual(exported.messages.map(message => message.presentationSpeaker), ["Alpha", "Alpha", "Beta", undefined, undefined]);
});
