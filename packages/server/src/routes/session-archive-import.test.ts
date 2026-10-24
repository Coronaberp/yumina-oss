import "../test/database-fixture.js";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, assets, userAssets, userLibrary } from "../db/schema.js";
import { importSessionArchive, sessionArchiveRoutes } from "./session-archives.js";
import { archiveImportIds, ARCHIVE_UPLOAD_CHUNK_BYTES } from "../lib/archive-upload-store.js";
import { auth } from "../lib/auth.js";
import { STORAGE_DIR } from "../lib/env.js";
import { requestBodyLimit } from "../middleware/request-body-limit.js";

const owner = crypto.randomUUID(), admin = crypto.randomUUID(), outsider = crypto.randomUUID();
let worldId: string, previewId: string;
const stamp = "2026-10-13T01:00:00.000Z";
function transcript() {
  return { format: "yumina-chat", version: 1, mode: "transcript", exportedAt: stamp,
    session: { id: "old-session", name: "Seven messages", createdAt: stamp, updatedAt: stamp },
    world: { id: worldId, name: "Private academy", description: "Original card" }, player: { name: "Player", avatar: null },
    participants: [], display: [], assets: {}, messages: Array.from({ length: 7 }, (_, i) => ({ id: `source-${i}`, role: i % 2 ? "user" : "assistant", content: `Saved ${i}`, createdAt: stamp })) };
}
before(async () => {
  for (const [id, role] of [[owner, "user"], [admin, "admin"], [outsider, "user"]] as const) await db.insert(user).values({ id, role, name: role, email: `${id}@test.invalid`, emailVerified: true });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Private academy", status: "draft", schema: { name: "Academy", entries: [], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }] } }).returning();
  worldId = world!.id;
  const [preview] = await db.insert(playSessions).values({ userId: admin, worldId, ephemeral: true, state: { untouched: true } }).returning();
  previewId = preview!.id;
});
after(async () => { mock.restoreAll(); if ("close" in db.$client) await db.$client.close(); });

test("matching active admin preview imports seven messages onto the same private card without media or library copies", async () => {
  const before = await db.select().from(worlds);
  const source = await db.select().from(playSessions).where(eq(playSessions.id, previewId));
  await assert.rejects(importSessionArchive(admin, transcript()), /original card/);
  const result = await importSessionArchive(admin, transcript(), { contextSessionId: previewId });
  assert.equal(result.worldId, worldId); assert.notEqual(result.sessionId, previewId);
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.equal(session!.ephemeral, true);
  const rows = await db.select().from(messages).where(eq(messages.sessionId, result.sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
  assert.deepEqual(rows.map(m => m.content), transcript().messages.map(m => m.content));
  assert.ok(rows.every(m => !m.id.startsWith("source-")));
  assert.deepEqual(await db.select().from(worlds), before);
  assert.deepEqual(await db.select().from(playSessions).where(eq(playSessions.id, previewId)), source);
  assert.equal((await db.select().from(userLibrary).where(eq(userLibrary.userId, admin))).length, 0);
  assert.equal((await db.select().from(assets)).length, 0);
  assert.equal((await db.select().from(userAssets)).length, 0);
});

test("preview context never grants a nonadmin, wrong owner, wrong card, normal session or revoked admin access", async () => {
  const [normal] = await db.insert(playSessions).values({ userId: admin, worldId }).returning();
  const [forged] = await db.insert(playSessions).values({ userId: outsider, worldId, ephemeral: true }).returning();
  const [otherWorld] = await db.insert(worlds).values({ creatorId: owner, name: "Other private", schema: { entries: [] } }).returning();
  const [wrongCard] = await db.insert(playSessions).values({ userId: admin, worldId: otherWorld!.id, ephemeral: true }).returning();
  for (const contextSessionId of ["missing", normal!.id, forged!.id, wrongCard!.id]) await assert.rejects(importSessionArchive(admin, transcript(), { contextSessionId }), /original card/);
  await assert.rejects(importSessionArchive(outsider, transcript(), { contextSessionId: forged!.id }), /original card/);
  await db.update(user).set({ role: "user" }).where(eq(user.id, admin));
  await assert.rejects(importSessionArchive(admin, transcript(), { contextSessionId: previewId }), /original card/);
  await db.update(user).set({ role: "admin" }).where(eq(user.id, admin));
});

test("ordinary transcript imports reuse original image references and concurrent retries restore only one session", async () => {
  const image = "/cdn/12345678-original";
  const archive = { ...transcript(), assets: { [image]: "data:image/png;base64,aGVsbG8=" } };
  archive.messages[0]!.content = `![portrait](${image})`;
  const ids = archiveImportIds(owner, crypto.randomUUID());
  const results = await Promise.all([importSessionArchive(owner, archive, ids), importSessionArchive(owner, archive, ids)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0]!.worldId, worldId);
  const rows = await db.select().from(messages).where(eq(messages.sessionId, ids.sessionId)).orderBy(asc(messages.id));
  assert.equal(rows.length, 7); assert.equal(rows[0]!.content, archive.messages[0]!.content);
  assert.equal((await db.select().from(assets)).length, 0); assert.equal((await db.select().from(userAssets)).length, 0);
  await db.update(worlds).set({ status: "published" }).where(eq(worlds.id, worldId));
  assert.equal((await importSessionArchive(outsider, transcript())).worldId, worldId);
  await db.update(worlds).set({ status: "draft" }).where(eq(worlds.id, worldId));
});

test("chunk endpoints obey normal body limits, ownership, malformed data errors and idempotent completion", async () => {
  let actor: string | null = owner;
  const login = mock.method(auth.api, "getSession", async () => actor ? { user: { id: actor }, session: { id: "test-login", userId: actor, expiresAt: new Date(Date.now() + 60000) } } : null);
  const app = new Hono(); app.use("*", requestBodyLimit); app.route("/api/session-archives", sessionArchiveRoutes);
  const id = crypto.randomUUID(), base = `/api/session-archives/uploads/${id}`;
  const data = Buffer.from(JSON.stringify(transcript())), json = { "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: string | Buffer, headers?: Record<string, string>) => app.request(path, { method, body, headers });
  actor = null; assert.equal((await request(base)).status, 401); actor = owner;
  assert.equal((await request(base, "POST", JSON.stringify({ totalBytes: data.length }), json)).status, 200);
  actor = outsider; assert.equal((await request(base)).status, 404); actor = owner;
  assert.equal((await request(`${base}/complete`, "POST")).status, 409);
  assert.equal((await request(`${base}/chunks/0`, "PUT", Buffer.alloc(ARCHIVE_UPLOAD_CHUNK_BYTES + 1))).status, 413);
  assert.equal((await request(`${base}/chunks/0`, "PUT", data)).status, 200);
  assert.equal((await request(`${base}/chunks/0`, "PUT", data)).status, 200);
  const completed = await request(`${base}/complete`, "POST"); assert.equal(completed.status, 201);
  const result = await completed.json() as { data: { sessionId: string; worldId: string } };
  assert.deepEqual(await (await request(`${base}/complete`, "POST")).json(), result);
  const status = await (await request(base)).json() as { data: { result: unknown } };
  assert.deepEqual(status.data.result, result.data);
  const stable = crypto.randomUUID(), directHeaders = { ...json, "X-Yumina-Archive-Request": stable };
  const direct = await request("/api/session-archives/import", "POST", data, directHeaders);
  assert.equal(direct.status, 201);
  assert.deepEqual(await (await request("/api/session-archives/import", "POST", data, directHeaders)).json(), await direct.json());
  const malformed = `/api/session-archives/uploads/${crypto.randomUUID()}`;
  await request(malformed, "POST", JSON.stringify({ totalBytes: 6 }), json);
  await request(`${malformed}/chunks/0`, "PUT", "<html>");
  const failed = await request(`${malformed}/complete`, "POST"); assert.equal(failed.status, 400); assert.match((await failed.json() as { error: string }).error, /embedded JSON/);
  assert.equal((await request("/api/session-archives/import", "POST", "{", json)).status, 400);
  assert.equal((await request("/api/session-archives/uploads/not-a-uuid", "POST", JSON.stringify({ totalBytes: 10 }), json)).status, 400);
  login.mock.restore();
});

test("full saves restore all asset bytes and state transactionally; failed imports leave no partial card or media", async () => {
  const sources = ["@asset:12345678-original", "/vn-assets/sprite.png", "https://old.example/cdn/12345678-original"];
  const bytes = sources.map((_, i) => Buffer.from(`preserve original asset ${i}`));
  const archive = { ...transcript(), mode: "full-save", world: { ...transcript().world, thumbnailUrl: sources[1], schema: { entries: [], variables: [], sprite: sources[0], background: sources[1], portrait: sources[2] } },
    assets: Object.fromEntries(sources.map((key, i) => [key, `data:image/png;base64,${bytes[i]!.toString("base64")}`])),
    restore: { state: { variables: { hp: 7 }, turnCount: 15, metadata: { sprite: sources[0] } }, persona: { persona: { name: "Saved player" }, started: true }, settings: { sessionMemoryPinned: "Saved continuity" }, checkpoints: [], memories: [], snippets: [] as Record<string, unknown>[], continuityNotes: ["Saved note"] } };
  const ids = archiveImportIds(owner, crypto.randomUUID());
  const before = { worlds: (await db.select().from(worlds)).length, sessions: (await db.select().from(playSessions)).length };
  await assert.rejects(importSessionArchive(owner, { ...archive, restore: { ...archive.restore, snippets: [{}] } }, ids));
  assert.equal((await db.select().from(worlds)).length, before.worlds); assert.equal((await db.select().from(playSessions)).length, before.sessions);
  assert.equal((await db.select().from(assets)).length, 0);
  const failedDirectory = join(STORAGE_DIR, "users", owner, "archives", ids.sessionId);
  assert.deepEqual(await readdir(failedDirectory).catch(() => []), []);
  const result = await importSessionArchive(owner, archive, ids); assert.notEqual(result.worldId, worldId);
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.deepEqual(session!.state.variables, { hp: 7 }); assert.equal(session!.state.turnCount, 15);
  assert.equal(session!.sessionPersona!.persona!.name, "Saved player"); assert.equal(session!.sessionMemoryPinned, "Saved continuity\n\nSaved note");
  const restoredAssets = await db.select().from(assets).where(eq(assets.worldId, result.worldId)); assert.equal(restoredAssets.length, 3);
  const saved = await Promise.all(restoredAssets.map(a => readFile(join(STORAGE_DIR, a.url))));
  assert.deepEqual(saved.map(b => b.toString()).sort(), bytes.map(b => b.toString()).sort());
  assert.equal((await db.select().from(messages).where(eq(messages.sessionId, result.sessionId))).length, 7);
  assert.deepEqual(await importSessionArchive(owner, archive, ids), result);
});
