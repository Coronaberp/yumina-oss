import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, userPersonas, playSessions, messages } from "../db/schema.js";
import { setSessionPersonaSelection, freezeSessionPersona, canSelectSessionPersona } from "./persona-selection.js";
import { resolvePersonaForSession, setSessionPersonaLock } from "./resolve-persona.js";

test("own and creator personas select only at greeting; play freezes identity without changing stats", async () => {
  const uid = crypto.randomUUID(), other = crypto.randomUUID();
  await db.insert(user).values([uid, other].map(id => ({ id, name: "Test", email: `${id}@test.local` })));
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: { personaPresets: [{ id: "student", name: "Student", appearance: "Blue", backstory: "Scholar" }] } }).returning();
    const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: { hp: 9 }, turnCount: 0 } }).returning();
    const [own, foreign] = await db.insert(userPersonas).values([{ userId: uid, name: "Own", isActive: true, note: "PRIVATE" }, { userId: other, name: "Foreign" }]).returning();
    assert.equal((await setSessionPersonaSelection(uid, session!.id, { kind: "player", id: foreign!.id })).error, "Persona not found");
    assert.equal((await setSessionPersonaSelection(uid, session!.id, { kind: "preset", id: "missing" })).error, "Persona not found");
    const selected = await setSessionPersonaSelection(uid, session!.id, { kind: "preset", id: "student" }, "");
    assert.ok(selected.data);
    assert.equal(selected.data.sessionPersona.persona?.name, "Student");
    assert.equal((await setSessionPersonaSelection(uid, session!.id, { kind: "account" }, "")).error, "Persona selection changed");
    const frozen = await freezeSessionPersona(uid, session!.id);
    assert.equal(frozen?.sessionPersona?.started, true);
    assert.equal(await canSelectSessionPersona(frozen!), false);
    assert.equal((await setSessionPersonaLock(uid, session!.id, true, own!.id)).error, "Persona can only be selected during the greeting");
    await db.update(worlds).set({ schema: { personaPresets: [] } }).where(eq(worlds.id, world!.id));
    assert.equal((await resolvePersonaForSession(frozen!))?.name, "Student");
    const [row] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.deepEqual(row!.state, { variables: { hp: 9 }, turnCount: 0 });
    const [legacy] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: {}, sessionPersona: { persona: { id: own!.id, name: "Own" } } }).returning();
    await db.insert(messages).values({ sessionId: legacy!.id, role: "user", content: "Hi" });
    assert.equal((await setSessionPersonaSelection(uid, legacy!.id, { kind: "account" })).error, "Persona can only be selected during the greeting");
    const fixed = await freezeSessionPersona(uid, legacy!.id);
    await db.update(userPersonas).set({ name: "Edited", isActive: false }).where(eq(userPersonas.id, own!.id));
    assert.equal((await resolvePersonaForSession(fixed!))?.name, "Own");
    assert.ok(!JSON.stringify(fixed!.sessionPersona).includes("PRIVATE"));
  } finally { await db.delete(user).where(eq(user.id, uid)); await db.delete(user).where(eq(user.id, other)); }
});
