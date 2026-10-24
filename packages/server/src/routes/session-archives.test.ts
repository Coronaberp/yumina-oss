import "../test/database-fixture.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, asc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, checkpoints, worldMemories, userPersonas } from "../db/schema.js";
import { exportSessionArchive, importSessionArchive } from "./session-archives.js";
import { replaceArchiveMediaReferences } from "@yumina/shared";
import { resolvePersonaForSession } from "../lib/resolve-persona.js";
import { canSelectSessionPersona } from "../lib/persona-selection.js";

const owner = `archive-owner-${crypto.randomUUID()}`;
after(async () => { await db.delete(user).where(eq(user.id, owner)); if ("close" in db.$client) await db.$client.close(); });
test("full save round trip restores state, persona, memory, checkpoint and fresh message IDs", async () => {
  await db.insert(user).values({ id: owner, name: "Archive owner", email: `${owner}@test.invalid` });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Archive world", schema: { name: "Archive world", entries: [], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }] } }).returning();
  const state = { variables: { hp: 7 }, turnCount: 1, metadata: {} };
  const persona = { persona: { name: "Chosen player", backstory: "My saved identity" }, started: true };
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state, sessionPersona: persona, summary: "Earlier story", sessionMemory: { text: "Sera knows the player." }, sessionMemoryPinned: "Keep the promise", name: "Original" }).returning();
  const [reply] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Saved reply", stateSnapshot: state, compacted: true, createdAt: new Date("2026-10-13T01:00:00Z"), swipes: [{ content: "Saved reply", rawContent: "[SPEAKER:Sera:normal] Saved reply", createdAt: "2026-10-13T01:00:00Z" }] }).returning();
  await db.update(playSessions).set({ sessionMemoryProcessedMessageId: reply!.id, summaryCoversUntilMessageId: reply!.id }).where(eq(playSessions.id, session!.id));
  await db.insert(checkpoints).values({ sessionId: session!.id, name: "Before the gate", state, messages: [{ ...reply, createdAt: reply!.createdAt!.toISOString() }], summary: "Checkpoint story" });
  await db.insert(worldMemories).values({ userId: owner, worldId: world!.id, sessionId: session!.id, content: "A promise", category: "agreement" });
  const archive = await exportSessionArchive(owner, session!.id, "full-save");
  const result = await importSessionArchive(owner, archive);
  assert.notEqual(result.sessionId, session!.id);
  const [restored] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.deepEqual(restored!.state, state);
  assert.equal(restored!.sessionPersona?.persona?.name, "Chosen player");
  assert.equal(restored!.summary, "Earlier story");
  assert.equal(restored!.sessionMemory?.text, "Sera knows the player.");
  const imported = await db.select().from(messages).where(eq(messages.sessionId, result.sessionId)).orderBy(asc(messages.createdAt));
  assert.equal(imported[0]!.content, "Saved reply");
  assert.notEqual(imported[0]!.id, reply!.id);
  assert.equal(imported[0]!.swipes![0]!.rawContent, "[SPEAKER:Sera:normal] Saved reply");
  assert.equal(restored!.sessionMemoryProcessedMessageId, imported[0]!.id);
  const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.sessionId, result.sessionId));
  assert.equal(checkpoint!.name, "Before the gate");
  assert.equal(checkpoint!.messages[0]!.id, imported[0]!.id);
  assert.equal(checkpoint!.messages[0]!.sessionId, result.sessionId);
  const [memory] = await db.select().from(worldMemories).where(eq(worldMemories.sessionId, result.sessionId));
  assert.equal(memory!.content, "A promise");
  const transcript = await exportSessionArchive(owner, session!.id, "transcript");
  assert.equal(transcript.restore, undefined);
  assert.equal(transcript.world.schema, undefined);
  assert.equal(transcript.messages[0]!.swipes, undefined);
  await assert.rejects(exportSessionArchive("another-user", session!.id, "full-save"));
  await assert.rejects(importSessionArchive(owner, { ...archive, version: 99 }));
  assert.equal((await db.select().from(messages).where(eq(messages.sessionId, session!.id))).length, 1);
});

test("full exports include more than the newest window and imports retain tied-date ordering", async () => {
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Long archive", schema: { name: "Long archive", entries: [], variables: [] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: `original-${String(index).padStart(4, "0")}`, sessionId: session!.id, role: "assistant" as const, content: `Message ${index}`, createdAt: new Date("2026-10-13T01:00:00Z") }));
  for (let start = 0; start < rows.length; start += 200) await db.insert(messages).values(rows.slice(start, start + 200));
  const archive = await exportSessionArchive(owner, session!.id, "full-save");
  assert.equal(archive.messages.length, 501);
  const result = await importSessionArchive(owner, archive);
  const restored = await db.select().from(messages).where(eq(messages.sessionId, result.sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
  assert.deepEqual(restored.map(m => m.content), rows.map(m => m.content));
  assert.equal(restored[0]!.createdAt!.toISOString(), rows[0]!.createdAt.toISOString());
});

test("transcript import seeds greeting defaults without duplicating the saved greeting", async () => {
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Greeting archive", schema: { name: "Greeting archive", entries: [{ id: "gate", name: "Gate opening", role: "greeting", content: "Saved greeting", enabled: true, initialVariables: { hp: 6 } }], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Saved greeting" });
  const archive = await exportSessionArchive(owner, session!.id, "transcript");
  const result = await importSessionArchive(owner, archive);
  const [restored] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.equal(restored!.state.activeGreetingId, "gate");
  assert.equal((restored!.state.variables as Record<string, unknown>).hp, 6);
  assert.equal((await db.select().from(messages).where(eq(messages.sessionId, result.sessionId))).length, 1);
});

test("absolute media URLs are remapped as complete tokens in CSS, interface source and markdown", () => {
  const source = 'const portrait="https://old.example/cdn/key/dXNlcnMvaW1hZ2U"; background:url("/vn-assets/portraits/person.png"); ![portrait](https://old.example/cdn/key/dXNlcnMvaW1hZ2U)';
  const references = new Map([["https://old.example/cdn/key/dXNlcnMvaW1hZ2U", "https://new.example/cdn/12345678-new"], ["/vn-assets/portraits/person.png", "https://new.example/cdn/87654321-new"]]);
  const result = replaceArchiveMediaReferences(source, references);
  assert.ok(!result.includes("old.example"));
  assert.ok(result.includes('portrait="https://new.example/cdn/12345678-new"'));
  assert.ok(result.includes('background:url("https://new.example/cdn/87654321-new")'));
  assert.ok(result.includes("![portrait](https://new.example/cdn/12345678-new)"));
});

test("archive memory ownership uses the session owner rather than a nonexistent metadata column", async () => {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS storyhaven_memory_sessions (session_id text PRIMARY KEY, backend text)`);
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Memory archive", schema: { name: "Memory archive", entries: [] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id }).returning();
  await db.execute(sql`INSERT INTO storyhaven_memory_sessions(session_id,backend) VALUES (${session!.id},'legacy')`);
  const archive = await exportSessionArchive(owner, session!.id, "full-save");
  assert.deepEqual(archive.restore!.continuityNotes, []);
});

test("full-save import retains an owned selected account profile and frozen continuity with a fresh version", async () => {
  const [profile] = await db.insert(userPersonas).values({ userId: owner, name: "Saved player", backstory: "Saved continuity", note: "PRIVATE NOTE", isActive: true }).returning();
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Persona archive", schema: { entries: [], variables: [] } }).returning();
  const identity = { persona: { id: profile!.id, name: "Saved player", backstory: "Saved continuity" }, selection: { kind: "account" as const }, selectionVersion: "source-version", started: true };
  const [source] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: { turnCount: 3 }, personaLocked: true, sessionPersona: identity }).returning();
  const archive = await exportSessionArchive(owner, source!.id, "full-save");
  await db.update(userPersonas).set({ name: "Edited account profile", backstory: "New profile text" }).where(eq(userPersonas.id, profile!.id));
  const result = await importSessionArchive(owner, archive);
  const [restored] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.deepEqual(restored!.sessionPersona!.persona, identity.persona);
  assert.deepEqual(restored!.sessionPersona!.selection, { kind: "account" });
  assert.notEqual(restored!.sessionPersona!.selectionVersion, identity.selectionVersion);
  assert.ok(restored!.sessionPersona!.selectionVersion);
  assert.deepEqual(await resolvePersonaForSession(restored!), identity.persona, "played saves keep their captured identity");
  assert.equal(await canSelectSessionPersona(restored!), false);
  assert.ok(!JSON.stringify(restored!.sessionPersona).includes("PRIVATE NOTE"));
  const [unchanged] = await db.select().from(playSessions).where(eq(playSessions.id, source!.id));
  assert.deepEqual(unchanged!.sessionPersona, identity);
});

test("imported greeting retains its owned player link so normal selected-profile edits still apply", async () => {
  const [profile] = await db.insert(userPersonas).values({ userId: owner, name: "Greeting player", backstory: "Saved greeting identity" }).returning();
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Greeting persona", schema: { entries: [], variables: [] } }).returning();
  const [source] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: { turnCount: 0 }, personaLocked: true,
    sessionPersona: { persona: { id: profile!.id, name: "Greeting player", backstory: "Saved greeting identity" }, selection: { kind: "player", id: profile!.id }, started: false } }).returning();
  const result = await importSessionArchive(owner, await exportSessionArchive(owner, source!.id, "full-save"));
  const [restored] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.deepEqual(restored!.sessionPersona!.selection, { kind: "player", id: profile!.id });
  assert.equal(await canSelectSessionPersona(restored!), true);
  await db.update(userPersonas).set({ backstory: "Edited greeting identity" }).where(eq(userPersonas.id, profile!.id));
  assert.equal((await resolvePersonaForSession(restored!))?.backstory, "Edited greeting identity");
});

test("full saves retain creator presets but never link another account's private player profile", async () => {
  const stranger = crypto.randomUUID();
  await db.insert(user).values({ id: stranger, name: "Other account", email: `${stranger}@test.invalid` });
  const [foreign] = await db.insert(userPersonas).values({ userId: stranger, name: "Foreign profile", note: "PRIVATE", backstory: "Foreign current text" }).returning();
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Creator persona", schema: { entries: [], variables: [], personaPresets: [{ id: "creator-player", name: "Creator player", backstory: "Creator continuity" }] } }).returning();
  const binding = { persona: { id: "creator-player", name: "Creator player", backstory: "Saved creator continuity" }, selection: { kind: "preset" as const, id: "creator-player" }, started: false };
  const [source] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: { turnCount: 0 }, sessionPersona: binding, personaLocked: true }).returning();
  const archive = await exportSessionArchive(owner, source!.id, "full-save");
  const result = await importSessionArchive(owner, archive);
  const [restored] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
  assert.deepEqual(restored!.sessionPersona!.selection, binding.selection);
  assert.deepEqual(await resolvePersonaForSession(restored!), binding.persona);
  const detached = await importSessionArchive(owner, { ...archive, restore: { ...archive.restore, persona: {
    persona: { id: foreign!.id, name: "Portable saved player", backstory: "Portable captured continuity" }, selection: { kind: "player", id: foreign!.id }, started: true } } });
  const [snapshot] = await db.select().from(playSessions).where(eq(playSessions.id, detached.sessionId));
  assert.equal(snapshot!.sessionPersona!.persona!.id, undefined);
  assert.equal(snapshot!.sessionPersona!.selection, undefined);
  assert.equal((await resolvePersonaForSession(snapshot!))?.backstory, "Portable captured continuity");
  assert.ok(!JSON.stringify(snapshot!.sessionPersona).includes("PRIVATE"));
  assert.equal((await db.select().from(userPersonas).where(eq(userPersonas.userId, owner))).some(row => row.id === foreign!.id), false);
  await db.delete(user).where(eq(user.id, stranger));
});
