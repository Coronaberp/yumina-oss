import { personaEntriesSchema, personaSpritesSchema, type PersonaEntry, type PersonaSprites } from "@yumina/shared";

/** Only role-play fields may cross into a world's sandbox. Private notes and
 * account identity stay in the host app. */
export interface PersonaProfile {
  name: string;
  appearance: string;
  personality: string;
  backstory: string;
  entries?: PersonaEntry[];
}

/** Local display only; callers send the original text back to the model. */
export function displayPersonaText(text: string, name = "Player"): string {
  return text.replace(/\{\{user\}\}/gi, () => name.trim() || "Player");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** The log uses the selected persona's identity, including an absent portrait.
 * An explicit No Persona selection must not inherit stale persona metadata. */
export function readPlayerPresentation(session: unknown, defaultName = "Player"): { name: string; avatar: string | null; sprites?: PersonaSprites } {
  const current = record(session);
  const metadata = record(record(current?.state)?.metadata);
  const binding = record(current?.sessionPersona);
  const explicit = !!binding && "persona" in binding;
  const persona = explicit ? record(binding.persona) : metadata?.personaActive === true ? { name: metadata.personaName, avatarUrl: metadata.personaImage } : null;
  if (persona) {
    const sprites = personaSpritesSchema.safeParse(persona.sprites);
    return {
      name: typeof persona.name === "string" && persona.name.trim() ? persona.name : defaultName,
      avatar: typeof persona.avatarUrl === "string" && persona.avatarUrl ? persona.avatarUrl : null,
      ...(sprites.success && Object.keys(sprites.data).length ? { sprites: sprites.data } : {}),
    };
  }
  const account = record(current?.currentUser);
  const name = account?.username || account?.displayUsername || account?.name;
  return { name: typeof name === "string" && name ? name : defaultName, avatar: typeof account?.image === "string" && account.image ? account.image : null };
}

/** Use the same saved session selection displayed by PersonaManagerDialog.
 * Never substitute global defaults: an explicit "No Persona" is meaningful.
 * Captured session IDs prevent a late sandbox request from reading another
 * session after navigation. Legacy hosts keep their saved metadata identity. */
export function readPersonaProfile(sessionId: string, session: unknown): PersonaProfile | null {
  const current = record(session);
  if (!sessionId || !current || current.id !== sessionId) return null;
  let persona: Record<string, unknown>;
  if (current.sessionPersona !== undefined && current.sessionPersona !== null) {
    const binding = record(current.sessionPersona);
    if (!binding || !("persona" in binding)) throw new Error("Invalid session Persona");
    if (binding.persona === null) return null;
    const selected = record(binding.persona);
    if (!selected || typeof selected.name !== "string") throw new Error("Invalid session Persona");
    persona = selected;
  } else {
    const metadata = record(record(current.state)?.metadata);
    if (metadata?.personaActive !== true || typeof metadata.personaName !== "string") return null;
    persona = { name: metadata.personaName, appearance: metadata.personaAppearance,
      personality: metadata.personaPersonality, backstory: metadata.personaBackstory, entries: metadata.personaEntries };
  }
  const field = (key: string) => typeof persona[key] === "string" ? persona[key] as string : "";
  return { name: field("name"), appearance: field("appearance"), personality: field("personality"), backstory: field("backstory"),
    ...(persona.entries !== undefined ? { entries: personaEntriesSchema.safeParse(persona.entries).data ?? [] } : {}),
  };
}
