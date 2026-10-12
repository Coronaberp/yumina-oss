import { z } from "zod";
import { personaSpritesSchema } from "@yumina/shared";

/** Public player identity only. World variables and effects belong to the creator's story rules. */
export const personaPresetSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(50),
  avatarUrl: z.string().max(2048).nullable().optional(),
  sprites: personaSpritesSchema.optional(),
  appearance: z.string().max(2000).nullable().optional(),
  personality: z.string().max(2000).nullable().optional(),
  backstory: z.string().max(5000).nullable().optional(),
}).strict();

export const personaPresetsSchema = z.array(personaPresetSchema).max(50).refine(
  rows => new Set(rows.map(row => row.id)).size === rows.length,
  { message: "Persona preset IDs must be unique" },
);
export type PersonaPreset = z.infer<typeof personaPresetSchema>;
