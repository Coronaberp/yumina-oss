import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, userPersonas, playSessions } from "../db/schema.js";
import { resolvePersonaSelection, setSessionPersonaSelection, freezeSessionPersona } from "./persona-selection.js";
import { resolvePersonaForSession, setAccountPersona, setSessionPersona, setSessionPersonaLock } from "./resolve-persona.js";
import { personaSelectionSchema } from "@yumina/shared";

test("each session keeps one persona while greeting selection remains available", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Private account", email: `${uid}@test.local` });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: {} }).returning();
    const [a, b] = await db.insert(userPersonas).values([{ userId: uid, name: "A", isActive: true }, { userId: uid, name: "B" }]).returning();
    const [created] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { turnCount: 0, variables: { hp: 9 } }, sessionPersona: { persona: { id: a!.id, name: "A" } } }).returning();
    const read = async () => (await db.select().from(playSessions).where(eq(playSessions.id, created!.id)))[0]!;
    await setAccountPersona(uid, b!.id);
    assert.equal((await resolvePersonaForSession(await read()))?.id, a!.id, "global defaults cannot replace an existing session identity");
    const beforeDisable = await read();
    assert.ok((await setSessionPersonaLock(uid, created!.id, false)).error);
    assert.ok((await setSessionPersona(uid, created!.id, null)).error);
    assert.deepEqual(await read(), beforeDisable, "disable attempts preserve identity and gameplay");
    for (const id of [b!.id, a!.id, b!.id]) {
      const selected = await setSessionPersonaSelection(uid, created!.id, { kind: "player", id });
      assert.equal(selected.data?.sessionPersona.persona?.id, id, "greeting choice can still change");
      assert.equal(selected.data?.personaLocked, true);
    }
    await freezeSessionPersona(uid, created!.id);
    assert.equal((await setSessionPersona(uid, created!.id, a!.id)).error, "Persona can only be selected during the greeting");
    assert.equal((await resolvePersonaForSession(await read()))?.id, b!.id);
    assert.deepEqual((await read()).state, { turnCount: 0, variables: { hp: 9 } });
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});

test("no profiles still supplies one Player persona and cannot be disabled", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Private account", email: `${uid}@test.local` });
  try {
    assert.equal(personaSelectionSchema.safeParse({ kind: "none" }).success, false);
    assert.equal((await resolvePersonaSelection(uid, { kind: "account" })).data?.name, "Player");
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: {} }).returning();
    const [created] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { turnCount: 0 } }).returning();
    assert.equal((await resolvePersonaForSession(created!))?.name, "Player");
    await db.insert(userPersonas).values({ userId: uid, name: "Later profile", isActive: true });
    const [bound] = await db.select().from(playSessions).where(eq(playSessions.id, created!.id));
    assert.equal((await resolvePersonaForSession(bound!))?.name, "Player", "new profile does not replace the session fallback");
    assert.equal((await freezeSessionPersona(uid, created!.id))?.sessionPersona?.persona?.name, "Player");
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});
