import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { studioTaskRequirementSchema, studioTaskSchema, type StudioTask, type StudioTaskCheck, type StudioTaskRequirement } from "@yumina/shared";
import type { WorldDefinition } from "@yumina/engine";

/** Stable observation fingerprints omit response clocks, never source text. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["updatedAt", "checkedAt", "timestamp", "durationMs", "elapsedMs", "elapsed"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const studioTaskRevision = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value)) ?? "undefined").digest("hex");

export function isStudioWorkRequest(text: string): boolean {
  if (/\b(?:just explain|only explain|do not change|don't change|no edits|don't edit|do not edit)\b/i.test(text)) return false;
  if (/^\s*(?:how|why|what|which|is|are|do|does|explain|tell me|describe|compare|can you explain)\b/i.test(text)) return false;
  return /\b(?:add|fix|repair|implement|create|build|update|change|remove|delete|convert|rewrite|refactor|enable|disable|replace|make|finish|complete|migrate|continue|do\s+(?:that|it|this))\b|(?:修复|修改|添加|创建|删除|更新|继续|直して|作って|追加して)/i.test(text);
}
export function createStudioTask(goal: string, mode: StudioTask["mode"], maxSteps?: number): StudioTask {
  return studioTaskSchema.parse({ version: 1, goal: goal.trim().slice(0, 40000) || "Complete the creator's current request.", mode, status: "working", planRequired: mode === "work", additionalRequests: [], requirements: [], met: false, maxSteps, steps: 0,
    progress: { worlds: [], observations: [], verified: [], noProgress: 0, recoveries: 0 } });
}
export function upsertTaskRequirements(task: StudioTask, input: unknown): StudioTask {
  if (!Array.isArray(input) || !input.length || input.length > 40) throw new Error("Supply 1–40 requirements with stable IDs and concrete checks.");
  const incoming = input.map(item => studioTaskRequirementSchema.parse(item));
  if (new Set(incoming.map(item => item.id)).size !== incoming.length) throw new Error("Requirement IDs must be unique.");
  const next = structuredClone(task);
  for (const requirement of incoming) {
    const item = { ...requirement, verified: false, evidence: [] };
    const index = next.requirements.findIndex(current => current.id === item.id);
    if (index < 0) next.requirements.push(item); else next.requirements[index] = item;
  }
  if (next.requirements.length > 40) throw new Error("A task supports at most 40 requirements. Existing requirements cannot be silently removed.");
  next.mode = "work"; next.planRequired = false; next.met = false; next.status = "working"; delete next.reason;
  return next;
}
function byPath(value: unknown, path: string): unknown {
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part) || ["__proto__", "prototype", "constructor"].includes(part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function target(world: WorldDefinition, check: Exclude<StudioTaskCheck, { kind: "validation" }>): unknown {
  if (check.kind === "world") return byPath(world, check.field);
  if (check.kind === "file") return world.rootComponent?.files?.[check.id] ?? world.customUI?.find(file => file.id === check.id || file.name === check.id)?.tsxCode;
  const entity = (world[check.collection] as Array<{ id: string }> | undefined)?.find(item => item.id === check.id);
  return check.field ? byPath(entity, check.field) : entity;
}
function compare(actual: unknown, check: Exclude<StudioTaskCheck, { kind: "validation" }>): boolean {
  switch (check.operator) {
    case "exists": return actual !== undefined;
    case "absent": return actual === undefined;
    case "eq": return Object.hasOwn(check, "value") && isDeepStrictEqual(actual, check.value);
    case "gte": return typeof actual === "number" && typeof check.value === "number" && actual >= check.value;
    case "length_gte": return (typeof actual === "string" || Array.isArray(actual)) && typeof check.value === "number" && actual.length >= check.value;
    case "contains": return typeof actual === "string" && typeof check.value === "string" && check.value.length > 0 ? actual.includes(check.value) : Array.isArray(actual) && check.value !== undefined && actual.some(item => isDeepStrictEqual(item, check.value));
    case "not_contains": return actual !== undefined && (typeof actual === "string" || Array.isArray(actual)) && check.value !== undefined && !compare(actual, { ...check, operator: "contains" });
  }
}
export function evaluateStudioTask(task: StudioTask, world: WorldDefinition, validate: (mode: "structure" | "full") => string[]): StudioTask {
  const next = structuredClone(task), validation = new Map<string, string[]>();
  next.checkedRevision = studioTaskRevision(world); next.checkedAt = new Date().toISOString();
  for (const requirement of next.requirements) {
    const results = requirement.checks.map(check => {
      if (check.kind === "validation") {
        if (!validation.has(check.mode)) validation.set(check.mode, validate(check.mode));
        const errors = validation.get(check.mode)!;
        return { passed: !errors.length, detail: errors.length ? `Validation: ${errors.slice(0, 3).join("; ")}` : `${check.mode} validation passed.` };
      }
      const passed = compare(target(world, check), check);
      const name = check.kind === "world" ? check.field : `${check.kind}:${check.id}${check.kind === "entity" && check.field ? "." + check.field : ""}`;
      return { passed, detail: `${passed ? "Passed" : "Unmet"}: ${name} ${check.operator}${check.value !== undefined ? " " + JSON.stringify(check.value).slice(0, 180) : ""}` };
    });
    requirement.verified = results.length > 0 && results.every(result => result.passed);
    requirement.evidence = results.length ? results.map(result => result.detail.slice(0, 500)) : ["No verifiable check is defined. Add a concrete check or ask the creator about this requirement."];
  }
  const errors = validation.get("full") ?? validate("full");
  if (!next.baselineCaptured) { next.baselineErrors = errors; next.baselineCaptured = true; }
  next.validationErrors = errors.filter(error => !next.baselineErrors.includes(error));
  next.met = !next.validationErrors.length && !next.planRequired && (next.mode === "answer" && !next.requirements.length || next.requirements.length > 0 && next.requirements.every(requirement => requirement.verified));
  return next;
}
const pushBounded = (items: string[], item: string, limit: number) => [...items.filter(value => value !== item), item].slice(-limit);
export function observeStudioTask(task: StudioTask, world: WorldDefinition, observations: unknown[]): { task: StudioTask; progress: boolean; recovery: boolean } {
  const next = structuredClone(task), state = next.progress;
  if (next.status === "stalled") return { task: next, progress: false, recovery: false };
  const revision = studioTaskRevision(world);
  const verified = studioTaskRevision(next.requirements.filter(r => r.verified).map(r => r.id).sort());
  const hashes = observations.map(value => studioTaskRevision(value));
  const progress = !state.worlds.includes(revision) || !state.verified.includes(verified) || hashes.some(hash => !state.observations.includes(hash));
  state.worlds = pushBounded(state.worlds, revision, 96);
  state.verified = pushBounded(state.verified, verified, 96);
  for (const hash of hashes) state.observations = pushBounded(state.observations, hash, 128);
  state.noProgress = progress ? 0 : state.noProgress + 1;
  if (progress) state.recoveries = 0;
  next.steps++;
  let recovery = false;
  if (state.noProgress >= 3) {
    state.noProgress = 0;
    if (state.recoveries >= 2) { next.status = "stalled"; next.reason = "Repeated attempts returned unchanged results without advancing the saved work or verified requirements. The task is saved and can be continued."; }
    else { state.recoveries++; recovery = true; }
  }
  return { task: next, progress, recovery };
}
export function studioTaskPrompt(task: StudioTask): string {
  return `Persistent task (server-owned; original request and requirements survive compaction; check_task_progress returns the full request if this summary is shortened):\n${JSON.stringify({ goal: task.goal.slice(0, 3000), mode: task.mode, status: task.status, planRequired: task.planRequired, additionalRequests: task.additionalRequests, requirements: task.requirements.map(r => ({ id: r.id, text: r.text.slice(0, 220), verified: r.verified, evidence: r.evidence.slice(0, 2) })) }).slice(0, 14000)}\nFor work, call update_task_plan with concrete checks, keep every requested requirement, act, then check_task_progress. A prose claim does not verify a change. Finish only after the saved work passes checks. Use ask_user for missing essential input. Reuse available facts, change approach after failures, and preserve player-authored content.\n`;
}
export function taskRecoveryNote(task: StudioTask): string {
  return `Recovery attempt ${task.progress.recoveries}/2: recent tool results and saved work are unchanged. Reuse information already returned. Review the original task and unmet checklist, choose a different useful approach, fix a failed write's arguments, or ask_user for a real missing input. Do not repeat the same unchanged calls, invent success or silently reduce the requirements.`;
}
export type { StudioTask, StudioTaskRequirement };

export class StudioTaskPause extends Error { constructor() { super("STUDIO_TASK_PAUSED"); } }
