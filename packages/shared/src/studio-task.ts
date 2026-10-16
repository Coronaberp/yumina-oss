import { z } from "zod";

const safePath = z.string().min(1).max(300).refine(path => !path.split(/[.\[\]]/).some(part => ["__proto__", "prototype", "constructor"].includes(part)), "Unsafe property path");
const comparison = {
  operator: z.enum(["exists", "absent", "eq", "contains", "not_contains", "length_gte", "gte"]).default("exists"),
  value: z.unknown().optional(),
};
export const studioTaskCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), collection: z.enum(["entries", "variables", "rules", "reactions", "chapters", "routes", "endings", "worldbooks", "audioTracks"]), id: z.string().min(1).max(200), field: safePath.optional(), ...comparison }),
  z.object({ kind: z.literal("world"), field: safePath, ...comparison }),
  z.object({ kind: z.literal("file"), id: z.string().min(1).max(300), ...comparison }),
  z.object({ kind: z.literal("validation"), mode: z.enum(["structure", "full"]).default("full") }),
]);
export const studioTaskRequirementSchema = z.object({
  id: z.string().min(1).max(100), text: z.string().min(1).max(2000), checks: z.array(studioTaskCheckSchema).max(16).default([]),
});
export const studioTaskSchema = z.object({
  version: z.literal(1), goal: z.string().min(1).max(40000), mode: z.enum(["answer", "work"]),
  status: z.enum(["working", "waiting", "completed", "needs_input", "stalled", "budget_paused", "stopped", "interrupted"]),
  planRequired: z.boolean().default(false), additionalRequests: z.array(z.string().max(16000)).max(100).default([]),
  requirements: z.array(studioTaskRequirementSchema.extend({ verified: z.boolean().default(false), evidence: z.array(z.string().max(500)).max(20).default([]) })).max(40),
  observedStep: z.string().optional(),
  met: z.boolean().default(false), checkedRevision: z.string().optional(), checkedAt: z.string().optional(), reason: z.string().max(2000).optional(),
  baselineCaptured: z.boolean().default(false), baselineErrors: z.array(z.string()).default([]), validationErrors: z.array(z.string()).default([]),
  maxSteps: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), steps: z.number().int().nonnegative().default(0),
  progress: z.object({ worlds: z.array(z.string()).max(96), observations: z.array(z.string()).max(128), verified: z.array(z.string()).max(96), noProgress: z.number().int().nonnegative(), recoveries: z.number().int().nonnegative() }),
});
export type StudioTaskCheck = z.infer<typeof studioTaskCheckSchema>;
export type StudioTaskRequirement = z.infer<typeof studioTaskRequirementSchema>;
export type StudioTask = z.infer<typeof studioTaskSchema>;
export function readStudioTask(context: Record<string, unknown> | null | undefined): StudioTask | null {
  const parsed = studioTaskSchema.safeParse(context?.studioTask);
  return parsed.success ? parsed.data : null;
}
