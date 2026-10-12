import { z } from "zod";

/** Account copies the current profile into this session; it never follows later global changes. */
export const personaSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }).strict(),
  z.object({ kind: z.literal("player"), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("preset"), id: z.string().min(1).max(100) }).strict(),
]);
export type PersonaSelection = z.infer<typeof personaSelectionSchema>;
