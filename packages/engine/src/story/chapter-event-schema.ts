import { z } from "zod";
import { conditionSchema } from "../world/condition-schema.js";
import type { WorldDefinition } from "../types/index.js";

const id = z.string().min(1).max(120);
export const chapterEventEffectSchema = z.object({
  variableId: z.string().min(1), operation: z.enum(["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]),
  value: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]), valueRef: z.string().optional(),
});
const entryChange = z.object({ entryId: id, enabled: z.boolean() });
export const chapterEventSceneSchema = z.object({
  id, name: z.string().min(1).max(200), instructions: z.string().max(8000).default(""),
  requiredMoments: z.array(z.object({ id, description: z.string().max(2000) })).max(16).default([]),
  completionConditions: z.array(conditionSchema).max(32).default([]),
  effects: z.array(chapterEventEffectSchema).max(64).default([]), entryChanges: z.array(entryChange).max(64).default([]),
});
export const chapterEventSchema = z.object({
  id, name: z.string().min(1).max(200), enabled: z.boolean().default(false), description: z.string().max(8000).default(""),
  conditions: z.array(conditionSchema).max(32).default([]), conditionLogic: z.enum(["all", "any"]).default("all"),
  scenes: z.array(chapterEventSceneSchema).max(40).default([]),
  effects: z.array(chapterEventEffectSchema).max(64).default([]), entryChanges: z.array(entryChange).max(64).default([]),
});
export type ChapterEvent = z.infer<typeof chapterEventSchema>;
export type ChapterEventScene = z.infer<typeof chapterEventSceneSchema>;
export interface ChapterEventProgress {
  chapterId: string; eventId: string; status: "active" | "completed"; sceneId: string;
  completedSceneIds: string[]; moments: Record<string, Record<string, string>>;
  startedTurn: number; completedTurn?: number;
}
export interface ChapterEventEvidence {
  chapterId: string; eventId: string; sceneId: string; narrative: string;
  moments: Array<{ momentId: string; quote: string }>;
}

export function chapterEventIssues(world: Pick<WorldDefinition, "chapters" | "entries" | "variables">): string[] {
  const issues: string[] = [], vars = new Set(world.variables.map(v => v.id)), entries = new Set(world.entries.map(e => e.id));
  const resolveVariable = (ref: string) => world.variables.find(v => v.id === ref) ?? world.variables.find(v => ref.startsWith(v.id + "."));
  const variableExists = (ref: string) => vars.has(ref) || Boolean(resolveVariable(ref));
  for (const chapter of world.chapters ?? []) {
    const eventIds = new Set<string>();
    for (const raw of chapter.events ?? []) {
      const parsed = chapterEventSchema.safeParse(raw);
      if (!parsed.success) { issues.push(`Chapter ${chapter.name}: event ${raw.id} has invalid fields.`); continue; }
      const event = parsed.data, prefix = `Event ${event.name}`;
      if (eventIds.has(event.id)) issues.push(`${prefix}: duplicate event ID.`);
      eventIds.add(event.id);
      if (event.enabled && !event.scenes.length) issues.push(`${prefix}: add at least one scene before enabling.`);
      const sceneIds = new Set<string>();
      for (const scene of event.scenes) {
        if (sceneIds.has(scene.id)) issues.push(`${prefix}: duplicate scene ID ${scene.id}.`);
        sceneIds.add(scene.id);
        if (event.enabled && (!scene.requiredMoments.length && !scene.completionConditions.length || scene.requiredMoments.some(m => !m.description.trim()))) issues.push(`${prefix}, scene ${scene.name}: add required moments or completion conditions.`);
        if (new Set(scene.requiredMoments.map(m => m.id)).size !== scene.requiredMoments.length) issues.push(`${prefix}, scene ${scene.name}: duplicate required moment ID.`);
      }
      for (const condition of [...event.conditions, ...event.scenes.flatMap(s => s.completionConditions)]) {
        for (const ref of [condition.variableId, condition.valueRef].filter(Boolean) as string[]) if (!variableExists(ref)) issues.push(`${prefix}: condition variable ${ref} does not exist.`);
      }
      for (const effect of [...event.effects, ...event.scenes.flatMap(s => s.effects)]) {
        if (!variableExists(effect.variableId) || effect.valueRef && !variableExists(effect.valueRef)) issues.push(`${prefix}: effect variable ${effect.variableId} does not exist.`);
        const variable = resolveVariable(effect.variableId);
        // Nested JSON paths keep their engine-supported operations. At a
        // declared scalar root, reject writes the engine would silently ignore.
        if (variable && variable.id === effect.variableId && variable.type !== "json") {
          const operations = variable.type === "number" ? ["set", "add", "subtract", "multiply"] : variable.type === "boolean" ? ["set", "toggle"] : ["set", "append"];
          const reference = effect.valueRef ? resolveVariable(effect.valueRef) : undefined;
          const refIsRoot = reference?.id === effect.valueRef;
          if (!operations.includes(effect.operation) || effect.operation !== "toggle" && (effect.valueRef ? refIsRoot && reference?.type !== variable.type : typeof effect.value !== variable.type)) issues.push(`${prefix}: incompatible effect for ${effect.variableId}.`);
        }
      }
      for (const change of [...event.entryChanges, ...event.scenes.flatMap(s => s.entryChanges)]) if (!entries.has(change.entryId)) issues.push(`${prefix}: lore entry ${change.entryId} does not exist.`);
    }
  }
  return issues;
}
