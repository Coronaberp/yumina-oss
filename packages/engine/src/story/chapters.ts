import { chapterEventSchema, chapterEventIssues } from "./chapter-event-schema.js";
import { z } from "zod";
import type { GameState, WorldDefinition } from "../types/index.js";
import { conditionSchema } from "../world/condition-schema.js";
import { checkConditions } from "../state/condition-evaluator.js";

export const chapterSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), enabled: z.boolean().default(true),
  description: z.string().default(""), timeline: z.string().default(""), date: z.string().default(""),
  events: z.array(chapterEventSchema).max(32).optional(),
  greetingIds: z.array(z.string()).default([]), nextChapterIds: z.array(z.string()).default([]),
  conditions: z.array(conditionSchema).default([]), conditionLogic: z.enum(["all", "any"]).default("all"),
  transitionText: z.string().default(""), transitionVariables: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});
export type StoryChapter = z.infer<typeof chapterSchema>;

export function activeChapter(world: Pick<WorldDefinition, "chapters">, state: Pick<GameState, "activeChapterId" | "activeGreetingId">): StoryChapter | undefined {
  const chapters = world.chapters ?? [];
  if (state.activeChapterId != null) return chapters.find(chapter => chapter.id === state.activeChapterId);
  const matches = chapters.filter(chapter => chapter.enabled !== false && (chapter.greetingIds ?? []).includes(state.activeGreetingId ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

/** No greeting defaults or history reset: the explicit edge and target conditions control entry. */
export function transitionChapter(world: WorldDefinition, state: GameState, chapterId: string): GameState {
  if (state.story?.status && state.story.status !== "playing") throw new Error("A completed or ending story cannot change chapter.");
  const current = activeChapter(world, state), target = world.chapters?.find(chapter => chapter.id === chapterId && chapter.enabled !== false);
  if (!current || !target || !(current.nextChapterIds ?? []).includes(chapterId)) throw new Error("This chapter transition is not allowed.");
  if (!checkConditions(state, target.conditions ?? [], target.conditionLogic ?? "all")) throw new Error("This chapter's entry conditions have not been met.");
  const issues = chapterIssues(world);
  if (issues.length) throw new Error(issues[0]);
  return { ...state, activeChapterId: chapterId, variables: { ...state.variables, ...target.transitionVariables }, metadata: { ...state.metadata } };
}

/** Validation shared by authoring tools, editor and transition endpoints. */
export function chapterIssues(world: Pick<WorldDefinition, "chapters" | "entries" | "variables" | "worldbooks">): string[] {
  const issues: string[] = [], ids = new Set<string>(), owners = new Map<string, string>();
  for (const chapter of world.chapters ?? []) {
    if (!chapterSchema.safeParse(chapter).success) issues.push(`Chapter ${chapter.id} has invalid fields.`);
    if (ids.has(chapter.id)) issues.push(`Duplicate chapter ID: ${chapter.id}`);
    ids.add(chapter.id);
    for (const id of chapter.greetingIds ?? []) {
      if (!world.entries.some(entry => entry.id === id && entry.role === "greeting")) issues.push(`Chapter ${chapter.name}: greeting ${id} does not exist.`);
      if (chapter.enabled !== false && owners.has(id)) issues.push(`Greeting ${id} belongs to more than one enabled chapter.`);
      if (chapter.enabled !== false) owners.set(id, chapter.id);
    }
    for (const [id, value] of Object.entries(chapter.transitionVariables ?? {})) {
      const variable = world.variables.find(variable => variable.id === id);
      if (!variable || variable.type !== typeof value || (typeof value === "number" && ((variable.min !== undefined && value < variable.min) || (variable.max !== undefined && value > variable.max)))) issues.push(`Chapter ${chapter.name}: invalid transition value for ${id}.`);
    }
    for (const condition of chapter.conditions ?? []) {
      for (const id of [condition.variableId, condition.valueRef].filter(Boolean) as string[]) {
        if (!world.variables.some(variable => variable.id === id || id.startsWith(variable.id + "."))) issues.push(`Chapter ${chapter.name}: condition variable ${id} does not exist.`);
      }
    }
  }
  for (const chapter of world.chapters ?? []) for (const id of chapter.nextChapterIds ?? []) {
    if (!ids.has(id) || id === chapter.id) issues.push(`Chapter ${chapter.name}: next chapter ${id} is invalid.`);
  }
  for (const book of world.worldbooks ?? []) for (const id of book.chapterIds ?? []) if (!ids.has(id)) issues.push(`Lorebook ${book.name}: chapter ${id} does not exist.`);
  return [...issues, ...chapterEventIssues(world)];
}

export function chapterPrompt(world: WorldDefinition, state: GameState): string {
  const chapter = activeChapter(world, state);
  return chapter ? `Current chapter (authoritative): ${JSON.stringify({ name: chapter.name, timeline: chapter.timeline, date: chapter.date, description: chapter.description })}. Preserve established history and outcomes. Do not merge alternate timelines or move to another chapter. Chapter selection is fixed after leaving the greeting.\n` : "";
}

export function chapterGreetingEnabled(world: Pick<WorldDefinition, "chapters">, greetingId: string): boolean {
  const linked = (world.chapters ?? []).filter(chapter => (chapter.greetingIds ?? []).includes(greetingId));
  return !linked.length || linked.some(chapter => chapter.enabled !== false);
}
