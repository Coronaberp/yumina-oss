import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { sessionRoutes } from "./sessions.js";
import { personaRoutes } from "./personas.js";
import { freezeSessionPersona } from "../lib/persona-selection.js";

test("HTTP creator selection is greeting-only, rejects status payloads, and keeps identity through reload", async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: "Private account", email: `${uid}@test.local` }).returning();
  const login = mock.method(auth.api, "getSession", async () => ({ user: account, session: { id: "test", userId: uid, expiresAt: new Date(Date.now() + 60000) } }));
  const req = (path: string, method = "GET", body?: object) => sessionRoutes.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Academy", schema: { version: "21.0.0", name: "Academy", entries: [{ id: "opening", name: "Opening", role: "greeting", position: "greeting", content: "Welcome {{user}}", enabled: true }], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 9 }], rules: [], components: [], audioTracks: [], settings: {}, personaPresets: [{ id: "student", name: "Student", personality: "Curious" }] } }).returning();
    const bad = await req("/", "POST", { worldId: world!.id, personaSelection: { kind: "preset", id: "student", initialVariables: { hp: 999 } } });
    assert.equal(bad.status, 400);
    const create = await req("/", "POST", { worldId: world!.id, ephemeral: true, personaSelection: { kind: "preset", id: "student" } });
    assert.equal(create.status, 201, await create.clone().text());
    const { data: session } = await create.json() as { data: typeof playSessions.$inferSelect };
    assert.equal(session.sessionPersona?.selection?.kind, "preset");
    assert.equal(session.sessionPersona?.persona?.name, "Student");
    assert.equal((session.state.variables as Record<string, unknown>).hp, 9);
    const [opening] = await db.select().from(messages).where(eq(messages.sessionId, session.id));
    assert.equal(opening!.content, "Welcome {{user}}", "greetings retain the private player token before UI display");
    let loaded = await (await req(`/${session.id}`)).json() as { data: { personaSelectable: boolean; sessionPersona: unknown } };
    assert.equal(loaded.data.personaSelectable, true);
    const change = await req(`/${session.id}/persona-selection`, "PUT", { selection: { kind: "account" }, expectedVersion: "" });
    assert.equal(change.status, 200);
    await freezeSessionPersona(uid, session.id);
    for (const body of [{ selection: { kind: "preset", id: "student" } }, { selection: { kind: "account" } }]) assert.equal((await req(`/${session.id}/persona-selection`, "PUT", body)).status, 409);
    assert.equal((await req(`/${session.id}/persona-lock`, "PUT", { locked: true, personaId: "missing" })).status, 409);
    assert.equal((await req(`/${session.id}/persona-selection`, "PUT", { selection: { kind: "none" } })).status, 400);
    // Removing all later history and rewinding state does not reopen identity selection.
    await db.delete(messages).where(eq(messages.sessionId, session.id));
    await db.update(playSessions).set({ state: { turnCount: 0, variables: { hp: 9 } } }).where(eq(playSessions.id, session.id));
    loaded = await (await req(`/${session.id}`)).json() as typeof loaded;
    assert.equal(loaded.data.personaSelectable, false);
    const invalidPersona = await personaRoutes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Stat injection", stats: { hp: 999 } }) });
    assert.equal(invalidPersona.status, 400);
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
