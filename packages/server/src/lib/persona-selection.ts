import { and, eq, or, sql } from "drizzle-orm";
import { personaPresetsSchema } from "@yumina/engine";
import { personaSelectionSchema, type PersonaSelection } from "@yumina/shared";
import { db } from "../db/index.js";
import { messages, playSessions, userPersonas, worlds } from "../db/schema.js";
import { resolveSessionWorldSchema } from "./pending-edit.js";
import { captureSessionPersona, legacySessionPersona, type SessionPersona } from "./session-persona.js";
import { isInstallationSharedWorld } from "./installation-shared-worlds.js";

type Executor = Pick<typeof db, "select" | "update" | "execute">;
const sessionColumns = { id: playSessions.id, userId: playSessions.userId, state: playSessions.state, sessionPersona: playSessions.sessionPersona, personaLocked: playSessions.personaLocked };
type Session = Pick<typeof playSessions.$inferSelect, "id" | "userId" | "state" | "sessionPersona" | "personaLocked">;
export type PersonaSelectionError = "Session not found" | "Persona not found" | "Persona selection changed" | "Persona can only be selected during the greeting" | "Each session must have one persona";
export type PersonaSelectionResult = { data: { personaLocked: boolean; sessionPersona: SessionPersona }; error?: never } | { error: PersonaSelectionError; data?: never };

export async function canSelectSessionPersona(session: Session, executor: Executor = db): Promise<boolean> {
  if (session.sessionPersona?.started || Number(session.state?.turnCount ?? 0) > 0) return false;
  // Legacy saves have no started marker. Authored greetings have no generation model.
  const [played] = await executor.select({ id: messages.id }).from(messages).where(and(
    eq(messages.sessionId, session.id),
    or(eq(messages.role, "user"), sql`${messages.model} IS NOT NULL`),
  )).limit(1);
  return !played;
}

export async function resolvePersonaSelection(userId: string, selection: PersonaSelection, schema?: unknown, executor: Executor = db) {
  if (selection.kind === "preset") {
    const parsed = personaPresetsSchema.safeParse((schema as { personaPresets?: unknown } | undefined)?.personaPresets ?? []);
    const preset = parsed.success ? parsed.data.find(row => row.id === selection.id) : undefined;
    return preset ? { data: preset } : { error: "Persona not found" as const };
  }
  const [persona] = await executor.select().from(userPersonas).where(and(
    eq(userPersonas.userId, userId), selection.kind === "account" ? eq(userPersonas.isActive, true) : eq(userPersonas.id, selection.id),
  )).limit(1);
  if (selection.kind === "player" && !persona) return { error: "Persona not found" as const };
  return { data: persona ?? { name: "Player" } };
}

/** Bind legacy optional/follow-global saves once, without changing gameplay. */
export async function ensureSessionPersona(session: Session): Promise<Session> {
  if (session.personaLocked && session.sessionPersona?.persona) return session;
  return db.transaction(async tx => {
    const [owned] = await tx.select(sessionColumns).from(playSessions).where(and(eq(playSessions.id, session.id), eq(playSessions.userId, session.userId))).for("update");
    if (!owned || owned.personaLocked && owned.sessionPersona?.persona) return owned ?? session;
    const greeting = await canSelectSessionPersona(owned, tx);
    let persona = owned.sessionPersona?.persona ?? legacySessionPersona(owned.state).persona;
    if (!persona && greeting) persona = (await resolvePersonaSelection(owned.userId, { kind: "account" }, undefined, tx)).data ?? null;
    const sessionPersona: SessionPersona = {
      ...captureSessionPersona(persona ?? { name: "Player" }),
      selection: personaSelectionSchema.safeParse(owned.sessionPersona?.selection).data ?? { kind: "account" },
      started: !greeting,
      selectionVersion: owned.sessionPersona?.selectionVersion ?? crypto.randomUUID(),
    };
    await tx.update(playSessions).set({ personaLocked: true, sessionPersona }).where(eq(playSessions.id, session.id));
    return { ...owned, personaLocked: true, sessionPersona };
  });
}

/** All persona selection paths share the row lock with first-turn freezing. */
export async function setSessionPersonaSelection(userId: string, sessionId: string, selection: PersonaSelection, expectedVersion?: string): Promise<PersonaSelectionResult> {
  let presetSchema: unknown;
  if (selection.kind === "preset") {
    const [owned] = await db.select({ worldId: playSessions.worldId }).from(playSessions).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
    if (!owned) return { error: "Session not found" };
    const [world] = await db.select().from(worlds).where(eq(worlds.id, owned.worldId));
    if (!world || world.status !== "published" && world.creatorId !== userId && !isInstallationSharedWorld(world.id, world.status)) return { error: "Persona not found" };
    presetSchema = await resolveSessionWorldSchema(world, userId);
  }
  return db.transaction(async tx => {
    const [owned] = await tx.select(sessionColumns).from(playSessions).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId))).for("update");
    if (!owned) return { error: "Session not found" };
    if (!await canSelectSessionPersona(owned, tx)) return { error: "Persona can only be selected during the greeting" };
    if (expectedVersion !== undefined && expectedVersion !== (owned.sessionPersona?.selectionVersion ?? "")) return { error: "Persona selection changed" };
    const resolved = await resolvePersonaSelection(userId, selection, presetSchema, tx);
    if (resolved.error) return { error: resolved.error };
    const binding: SessionPersona = { ...captureSessionPersona(resolved.data), selection, selectionVersion: crypto.randomUUID() };
    const personaLocked = true;
    await tx.update(playSessions).set({ personaLocked, sessionPersona: binding, updatedAt: new Date() }).where(eq(playSessions.id, sessionId));
    return { data: { personaLocked, sessionPersona: binding } };
  });
}

/** Capture identity before generation. Rewinding history never reopens selection. */
export async function freezeSessionPersona(userId: string, sessionId: string) {
  return db.transaction(async tx => {
    const [owned] = await tx.select(sessionColumns).from(playSessions).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId))).for("update");
    if (!owned || owned.sessionPersona?.started && owned.sessionPersona.persona) return owned ?? null;
    let persona = owned.sessionPersona?.persona ?? legacySessionPersona(owned.state).persona;
    // An old story's captured identity wins over subsequent account changes.
    const greeting = await canSelectSessionPersona(owned, tx);
    if (greeting && !persona) {
      persona = (await resolvePersonaSelection(userId, { kind: "account" }, undefined, tx)).data ?? null;
    } else if (greeting && persona?.id && owned.sessionPersona?.selection?.kind !== "preset") {
      const [current] = await tx.select().from(userPersonas).where(and(eq(userPersonas.id, persona.id), eq(userPersonas.userId, userId)));
      persona = current ?? persona;
    }
    const sessionPersona: SessionPersona = { ...captureSessionPersona(persona ?? { name: "Player" }), selection: personaSelectionSchema.safeParse(owned.sessionPersona?.selection).data ?? { kind: "account" }, started: true, selectionVersion: crypto.randomUUID() };
    await tx.update(playSessions).set({ personaLocked: true, sessionPersona }).where(eq(playSessions.id, sessionId));
    return { ...owned, personaLocked: true, sessionPersona };
  });
}
