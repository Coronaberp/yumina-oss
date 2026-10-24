import { randomUUID } from "node:crypto";
import { z } from "zod";
import { personaSelectionSchema } from "@yumina/shared";
import type { SessionPersona } from "./session-persona.js";

export const archivePersonaSchema = z.object({
  started: z.boolean().optional(), selection: personaSelectionSchema.optional(),
  persona: z.object({
    id: z.string().min(1).max(100).optional(), name: z.string(), avatarUrl: z.string().nullable().optional(),
    appearance: z.string().nullable().optional(), personality: z.string().nullable().optional(), backstory: z.string().nullable().optional(),
    entries: z.array(z.object({ title: z.string(), content: z.string() })).optional(), sprites: z.record(z.unknown()).optional(),
  }).nullable(),
});
export type ArchivePersona = z.infer<typeof archivePersonaSchema>;
export function archivePersonaProfileId(binding: ArchivePersona): string | undefined {
  if (!binding.persona || binding.selection?.kind === "preset") return undefined;
  const id = binding.selection?.kind === "player" ? binding.selection.id : binding.persona.id;
  return binding.persona.id && binding.persona.id !== id ? undefined : id;
}
export function restoreArchivePersona(binding: ArchivePersona, context: { ownedProfileId?: string; presetIds: ReadonlySet<string> }): SessionPersona {
  const snapshot = binding.persona ? { ...binding.persona } : null;
  if (snapshot) delete snapshot.id;
  let selection: SessionPersona["selection"];
  const profileId = archivePersonaProfileId(binding);
  if (snapshot && binding.selection?.kind === "preset" && context.presetIds.has(binding.selection.id)
      && (!binding.persona?.id || binding.persona.id === binding.selection.id)) {
    snapshot.id = binding.selection.id;
    selection = binding.selection;
  } else if (snapshot && profileId && profileId === context.ownedProfileId) {
    snapshot.id = profileId;
    selection = binding.selection ?? { kind: "account" };
  } else if (binding.selection?.kind === "account") selection = { kind: "account" };
  // Keep captured public details even when the source profile is unavailable.
  // A destination concurrency token must never reuse the source session's token.
  return { persona: snapshot as SessionPersona["persona"], started: binding.started,
    ...(selection ? { selection } : {}), selectionVersion: randomUUID() };
}
