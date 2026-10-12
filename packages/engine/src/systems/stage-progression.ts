import { z } from "zod";
import type { Effect, GameState } from "../types/index.js";
import type { GameEvent } from "../events/types.js";

const stageSchema = z.object({
  label: z.string().min(1), capacity: z.number().finite().positive(), milestone: z.string().min(1).optional(),
});
const progressionSchema = z.object({
  type: z.literal("progression:resolve"),
  checkpointVariableId: z.string().min(1),
  readyVariableId: z.string().min(1).optional(),
  phaseVariableId: z.string().min(1).optional(),
  maxProgress: z.number().finite().positive(),
  ladders: z.record(z.array(stageSchema).min(2)),
  tracks: z.array(z.object({
    scoreVariableId: z.string().min(1), stateVariableId: z.string().min(1), ladder: z.string().min(1),
    defaultState: z.string().min(1), aliases: z.record(z.string()).default({}),
    milestoneVariables: z.record(z.string().min(1)).default({}),
  })).min(1),
}).refine(config => {
  const ids = new Set<string>();
  return config.tracks.every(track => {
    const stages = config.ladders[track.ladder];
    if (!stages || ids.has(track.scoreVariableId)) return false;
    ids.add(track.scoreVariableId);
    const labels = new Set(stages.map(stage => stage.label));
    return labels.size === stages.length && labels.has(track.defaultState)
      && Object.values(track.aliases).every(label => labels.has(label))
      && stages.every(stage => stage.capacity <= config.maxProgress
        && (!stage.milestone || !!track.milestoneVariables[stage.milestone]));
  });
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Resolve authored stage ladders once, using actual state-change events as action
 * evidence. Checkpoints alone never turn an idle full bar into a promotion.
 * No card ids, story policy, or stage thresholds are hardcoded here.
 */
export function resolveStageProgression(event: GameEvent, state: GameState, events: GameEvent[]): Effect[] {
  const parsed = progressionSchema.safeParse(event);
  if (!parsed.success) return [];
  const config = parsed.data;
  const vars = state.variables;
  const checkpoints = { ...record(vars[config.checkpointVariableId]) };
  const effects: Effect[] = [];
  const write = (variableId: string, value: Effect["value"]) => {
    if (Object.hasOwn(vars, variableId) && vars[variableId] !== value) effects.push({ variableId, operation: "set", value });
  };
  const validScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= config.maxProgress;
  const collecting = !config.phaseVariableId || vars[config.phaseVariableId] === "collect";

  for (const track of config.tracks) {
    if (!Object.hasOwn(vars, track.scoreVariableId) || !Object.hasOwn(vars, track.stateVariableId)) continue;
    const stages = config.ladders[track.ladder]!;
    const checkpoint = record(checkpoints[track.scoreVariableId]);
    const raw = vars[track.scoreVariableId];
    let score = validScore(raw) ? raw : validScore(checkpoint.last) ? checkpoint.last : 0;
    const stored = vars[track.stateVariableId];
    const label = typeof stored === "string" && Object.hasOwn(track.aliases, stored) ? track.aliases[stored] : stored;
    let index = stages.findIndex(stage => stage.label === label);
    if (index < 0) index = stages.findIndex(stage => stage.label === track.defaultState);
    const current = stages[index]!;
    const earned = new Set(Object.entries(track.milestoneVariables).filter(([, id]) => vars[id] === true).map(([key]) => key));
    const revoked = new Set<string>();
    const changed = validScore(raw) && (checkpoint.pending === true || (collecting && events.some(change => {
      if (change.type !== "state:changed") return false;
      if (change.variableId === track.scoreVariableId) return validScore(change.newValue) && raw !== checkpoint.last;
      return Object.values(track.milestoneVariables).includes(String(change.variableId))
        && change.newValue === true && change.oldValue !== true && vars[String(change.variableId)] === true;
    })));

    if (changed && score >= current.capacity && index < stages.length - 1
      && stages.slice(0, index + 2).every(stage => !stage.milestone || earned.has(stage.milestone))) {
      index++;
      score = 0;
    } else if (changed && score <= -current.capacity && index > 0) {
      for (const stage of stages.slice(index)) {
        if (!stage.milestone) continue;
        const id = track.milestoneVariables[stage.milestone]!;
        write(id, false);
        earned.delete(stage.milestone);
        revoked.add(id);
      }
      index--;
      score = 0;
    }
    const resolved = stages[index]!;
    score = Math.max(-resolved.capacity, Math.min(resolved.capacity, score));
    write(track.stateVariableId, resolved.label);
    write(track.scoreVariableId, score);
    checkpoints[track.scoreVariableId] = {
      ...checkpoint, last: score, pending: false,
      milestones: { ...record(checkpoint.milestones),
        ...Object.fromEntries(Object.values(track.milestoneVariables).map(id => [id, revoked.has(id) ? false : vars[id]])),
      },
    };
  }
  write(config.checkpointVariableId, checkpoints);
  if (config.readyVariableId) write(config.readyVariableId, true);
  if (config.phaseVariableId) write(config.phaseVariableId, "collect");
  return effects;
}
