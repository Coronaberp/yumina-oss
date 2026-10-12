import { and, eq, sql } from "drizzle-orm";
import { db, type DrizzleDB } from "../db/index.js";
import { playSessions, userPersonas } from "../db/schema.js";

import { captureSessionPersona, type SessionPersona } from "./session-persona.js";
import { setSessionPersonaSelection, canSelectSessionPersona, freezeSessionPersona, ensureSessionPersona, type PersonaSelectionError } from "./persona-selection.js";

export type ResolvedPersona = typeof userPersonas.$inferSelect;

/** Resolve the default account selection copied into a new session. Read the
 * primary so a just-saved choice is visible to the next load or generation.
 * Legacy world pins remain historical data and never override this choice. */
export async function resolvePersonaForWorld(
  userId: string,
  _worldId: string | null | undefined,
  database: DrizzleDB = db,
): Promise<ResolvedPersona | null> {
  const [active] = await database
    .select()
    .from(userPersonas)
    .where(and(eq(userPersonas.userId, userId), eq(userPersonas.isActive, true)))
    .limit(1);
  return active ?? null;
}

/** Each session keeps one identity. Public edits to its selected profile apply
 * during the greeting; the snapshot is fixed once the first player turn begins. */
export async function resolvePersonaForSession(session: Pick<typeof playSessions.$inferSelect, "id" | "userId" | "state" | "sessionPersona" | "personaLocked">) {
  session = await ensureSessionPersona(session);
  if (session.sessionPersona?.started || session.sessionPersona?.selection?.kind === "preset") return session.sessionPersona?.persona ?? null;
  if (!await canSelectSessionPersona(session)) return (await freezeSessionPersona(session.userId, session.id))?.sessionPersona?.persona ?? null;
  const snapshot = session.sessionPersona?.persona ?? null;
  if (!snapshot?.id) return snapshot;
  const [current] = await db
    .select()
    .from(userPersonas)
    .where(and(eq(userPersonas.id, snapshot.id), eq(userPersonas.userId, session.userId)))
    .limit(1);
  return current ?? snapshot;
}

/** Account/profile selection only. Lock in a stable order so concurrent
 * choices cannot leave multiple personas active. Never copy private notes. */
export async function setAccountPersona(userId: string, personaId: string | null) {
  return db.transaction(async (tx) => {
    const personas = await tx.select().from(userPersonas)
      .where(eq(userPersonas.userId, userId)).orderBy(userPersonas.id).for("update");
    const persona = personas.find((p) => p.id === personaId);
    if (personaId !== null && !persona) return { error: "Persona not found" } as const;
    await tx.update(userPersonas).set({
      isActive: personaId === null ? false : sql`${userPersonas.id} = ${personaId}`,
      updatedAt: new Date(),
    }).where(eq(userPersonas.userId, userId));
    return { data: captureSessionPersona(persona ?? null) } as const;
  });
}

/** Session and persona must both belong to the authenticated user. */
export async function setSessionPersona(userId: string, sessionId: string, personaId: string | null, expectedVersion?: string): Promise<
  { data: SessionPersona; error?: never } | { error: PersonaSelectionError; data?: never }
> {
  const result = await setSessionPersonaLock(userId, sessionId, true, personaId, expectedVersion);
  if (result.error) return { error: result.error };
  // Preserve the legacy response shape, but never write the account default.
  return { data: result.data.sessionPersona };
}

/** Compatibility endpoint: selecting a persona is allowed; disabling is not. */
export async function setSessionPersonaLock(
  userId: string,
  sessionId: string,
  locked: boolean,
  personaId?: string | null,
  expectedVersion?: string,
): Promise<
  { data: { personaLocked: boolean; sessionPersona: SessionPersona }; error?: never }
  | { error: PersonaSelectionError; data?: never }
> {
  if (!locked || personaId === null) return { error: "Each session must have one persona" };
  if (personaId === undefined) return { error: "Persona not found" };
  return setSessionPersonaSelection(userId, sessionId, { kind: "player", id: personaId }, expectedVersion);
}
