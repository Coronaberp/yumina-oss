import type { GameState, WorldDefinition } from "../types/index.js";
import type { GameStateManager } from "../state/game-state-manager.js";
import { checkConditions } from "../state/condition-evaluator.js";
import { activeChapter } from "./chapters.js";
import { chapterEventIssues, chapterEventSchema, type ChapterEventEvidence, type ChapterEventProgress } from "./chapter-event-schema.js";

const keyFor = (chapterId: string, eventId: string) => JSON.stringify([chapterId, eventId]);

/** Pure selection: inspecting a prompt or old snapshot never changes a save. */
export function chapterEventContext(world: WorldDefinition, state: GameState) {
  if (state.story?.status && state.story.status !== "playing") return undefined;
  const chapter = activeChapter(world, state);
  if (!chapter || chapter.enabled === false) return undefined;
  const candidates = (chapter.events ?? []).map(raw => chapterEventSchema.safeParse(raw)).filter(parsed => parsed.success).map(parsed => parsed.data!);
  const ordered = [...candidates.filter(e => state.storyEvents?.[keyFor(chapter.id, e.id)]?.status === "active"), ...candidates.filter(e => !state.storyEvents?.[keyFor(chapter.id, e.id)])];
  for (const event of ordered) {
    if (!event.enabled || !event.scenes.length || chapterEventIssues({ ...world, chapters: [{ ...chapter, events: [event] }] }).length) continue;
    const progress = state.storyEvents?.[keyFor(chapter.id, event.id)];
    if (progress?.status === "completed") continue;
    if (!progress && !checkConditions(state, event.conditions, event.conditionLogic)) continue;
    const scene = progress ? event.scenes.find(s => s.id === progress.sceneId) : event.scenes[0];
    if (!scene) continue; // A removed active scene cannot silently skip ahead.
    const completed = progress?.moments[scene.id] ?? {};
    return { chapter, event, scene, progress, remainingMoments: scene.requiredMoments.filter(m => !Object.hasOwn(completed, m.id)) };
  }
  return undefined;
}

/** Starting an eligible event records no moments and applies no effects. */
export function initializeChapterEvents(world: WorldDefinition, state: GameState): GameState {
  const context = chapterEventContext(world, state);
  if (!context || context.progress) return state;
  const { chapter, event, scene } = context;
  const progress: ChapterEventProgress = { chapterId: chapter.id, eventId: event.id, sceneId: scene.id, status: "active", completedSceneIds: [], moments: {}, startedTurn: state.turnCount };
  return { ...state, storyEvents: { ...state.storyEvents, [keyFor(chapter.id, event.id)]: progress } };
}

export function chapterEventPrompt(world: WorldDefinition, state: GameState): string {
  const current = chapterEventContext(world, state);
  if (!current) return "";
  return `Current chapter event (authoritative): ${JSON.stringify({ event: current.event.name, scene: current.scene.name, instructions: current.scene.instructions, requiredMoments: current.remainingMoments.map(m => m.description), alreadyOccurred: current.scene.requiredMoments.filter(m => !current.remainingMoments.includes(m)).map(m => m.description) })}\nDevelop only this scene. Required moments must actually occur in the narrated present, not merely be predicted, mentioned, imagined or negated. Preserve the player's control of their own actions and dialogue. Do not repeat completed moments, invent later scenes, mark your own progress, or emit event metadata. The engine checks scene completion and applies its lasting effects.\n`;
}

/** Evidence is server-reviewed, never parsed from the story model's own claims.
 * Quote containment and current IDs are still checked locally. One call can
 * finish at most one scene; a replay can never apply its effects twice. */
export function advanceChapterEvents(world: WorldDefinition, manager: GameStateManager, evidence?: ChapterEventEvidence) {
  const changes: ReturnType<GameStateManager["applyEffects"]> = [];
  const state = manager.getSnapshot(), current = chapterEventContext(world, state);
  if (!current) return changes;
  const { chapter, event, scene } = current;
  if (!evidence || evidence.chapterId !== chapter.id || evidence.eventId !== event.id || evidence.sceneId !== scene.id) return changes;
  const progress: ChapterEventProgress = structuredClone(current.progress ?? { chapterId: chapter.id, eventId: event.id, sceneId: scene.id, status: "active", completedSceneIds: [], moments: {}, startedTurn: state.turnCount });
  const confirmed = { ...(progress.moments[scene.id] ?? {}) };
  for (const moment of evidence.moments) {
    if (scene.requiredMoments.some(m => m.id === moment.momentId) && moment.quote.trim().length >= 8 && moment.quote.length <= 600 && evidence.narrative.includes(moment.quote)) confirmed[moment.momentId] = moment.quote;
  }
  progress.moments[scene.id] = confirmed;
  const ready = scene.requiredMoments.every(m => Object.hasOwn(confirmed, m.id)) && checkConditions(state, scene.completionConditions, "all");
  if (ready && !progress.completedSceneIds.includes(scene.id)) {
    progress.completedSceneIds.push(scene.id);
    changes.push(...manager.applyEffects(scene.effects));
    for (const change of scene.entryChanges) manager.toggleEntry(change.entryId, change.enabled);
    const next = event.scenes[event.scenes.findIndex(s => s.id === scene.id) + 1];
    if (next) progress.sceneId = next.id;
    else {
      progress.status = "completed"; progress.completedTurn = state.turnCount;
      changes.push(...manager.applyEffects(event.effects));
      for (const change of event.entryChanges) manager.toggleEntry(change.entryId, change.enabled);
    }
  }
  const updated = manager.getSnapshot();
  manager.loadSnapshot({ ...updated, storyEvents: { ...updated.storyEvents, [keyFor(chapter.id, event.id)]: progress } });
  return changes;
}
