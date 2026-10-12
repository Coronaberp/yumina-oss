import type { Condition, GameState, WorldDefinition } from "../types/index.js";
import type { StoryEnding, StoryProgress } from "../types/story.js";
import { checkConditions } from "../state/condition-evaluator.js";

export interface StoryProgressOptions { selectEnding?: boolean; operationId?: string }
export interface StoryValidationIssue { entityId: string; message: string }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function variableRoot(ref: string): string { return ref.split(/[.[\]]/, 1)[0] ?? ref; }
function validConditions(conditions: Condition[], vars: Set<string>): boolean {
  return conditions.every((condition) => (vars.has(condition.variableId) || vars.has(variableRoot(condition.variableId))) && (!condition.valueRef || (vars.has(condition.valueRef) || vars.has(variableRoot(condition.valueRef)))));
}
function meets(conditions: Condition[], logic: "all" | "any", vars: Set<string>, state: GameState): boolean {
  if (!validConditions(conditions, vars)) return false;
  return checkConditions(state, conditions, logic);
}
function sortPriority<T extends { priority: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function endingDefinitionValid(ending: StoryEnding, routeIds: Set<string>, vars: Set<string>): boolean {
  if (!ending.id || !ending.outcome.trim() || !validConditions(ending.conditions, vars)) return false;
  if (ending.routeIds.some((id) => !routeIds.has(id))) return false;
  if (ending.conditions.length === 0 && !ending.allowUnconditional) return false;
  if (ending.mode === "authored" && !ending.prose.trim()) return false;
  if (ending.mode === "ai" && !ending.guidance.trim()) return false;
  return true;
}

export function resolveStoryProgress(world: WorldDefinition, input: GameState, options: StoryProgressOptions = {}): GameState {
  const state = clone(input);
  const defsExist = (world.routes?.length ?? 0) > 0 || (world.endings?.length ?? 0) > 0 || Boolean(state.story);
  if (!defsExist || world.settings?.storyStructureEnabled === false) return state;
  const current: StoryProgress = clone(state.story ?? { status: "playing" });
  if (current.status !== "playing") { state.story = current; return state; }

  const variables = new Set(world.variables.map((variable) => variable.id));
  const routes = world.routes ?? [];
  const routeIds = new Set(routes.map((route) => route.id));
  const duplicateRouteIds = new Set(routes.filter((route, index) => routes.findIndex((candidate) => candidate.id === route.id) !== index).map((route) => route.id));
  const locked = current.route?.locked === true;
  const eligibleRoutes = sortPriority(routes.filter((route) => route.enabled && !duplicateRouteIds.has(route.id) && validConditions(route.conditions, variables) && meets(route.conditions, route.conditionLogic, variables, state)));
  const chosenRoute = locked ? undefined : eligibleRoutes[0];
  if (!current.route && chosenRoute) {
    current.route = { id: chosenRoute.id, name: chosenRoute.name, guidance: chosenRoute.guidance, enteredTurn: state.turnCount, locked: chosenRoute.lockOnEntry };
  } else if (current.route && chosenRoute && chosenRoute.id !== current.route.id) {
    current.route = { id: chosenRoute.id, name: chosenRoute.name, guidance: chosenRoute.guidance, enteredTurn: state.turnCount, locked: chosenRoute.lockOnEntry };
  }

  if (options.selectEnding !== false) {
    const endings = world.endings ?? [];
    const duplicateEndingIds = new Set(endings.filter((ending, index) => endings.findIndex((candidate) => candidate.id === ending.id) !== index).map((ending) => ending.id));
    const ending = sortPriority(endings.filter((candidate) => {
      if (duplicateEndingIds.has(candidate.id)) return false;
      if (!candidate.enabled || !endingDefinitionValid(candidate, routeIds, variables)) return false;
      if (candidate.routeIds.length > 0 && (!current.route || !candidate.routeIds.includes(current.route.id))) return false;
      return meets(candidate.conditions, candidate.conditionLogic, variables, state);
    }))[0];
    if (ending) {
      current.status = "ending-ready";
      current.ending = { id: ending.id, name: ending.name, outcome: ending.outcome, mode: ending.mode, prose: ending.prose, guidance: ending.guidance, selectedTurn: state.turnCount, operationId: options.operationId ?? `ending:${ending.id}:${state.turnCount}` };
    }
  }
  state.story = current;
  return state;
}

export function completeStoryEnding(input: GameState, presentation: string): GameState {
  if (input.story?.status !== "ending-ready" || !input.story.ending || !presentation.trim()) throw new Error("A pending ending and non-empty presentation are required");
  const state = clone(input);
  state.story = { ...state.story!, status: "completed", presentation };
  return state;
}

export function getStoryValidationIssues(world: WorldDefinition): StoryValidationIssue[] {
  const issues: StoryValidationIssue[] = [];
  const vars = new Set(world.variables.map((variable) => variable.id));
  const routes = world.routes ?? [];
  const endings = world.endings ?? [];
  const routeIds = new Set<string>();
  const endingIds = new Set<string>();
  for (const route of routes) {
    if (routeIds.has(route.id)) issues.push({ entityId: route.id, message: "Duplicate route id" });
    routeIds.add(route.id);
    route.conditions.forEach((condition) => {
      if (!(vars.has(condition.variableId) || vars.has(variableRoot(condition.variableId))) || (condition.valueRef && !(vars.has(condition.valueRef) || vars.has(variableRoot(condition.valueRef))))) issues.push({ entityId: route.id, message: "Route condition references a missing variable" });
    });
  }
  for (const ending of endings) {
    if (endingIds.has(ending.id)) issues.push({ entityId: ending.id, message: "Duplicate ending id" });
    endingIds.add(ending.id);
    ending.conditions.forEach((condition) => {
      if (!(vars.has(condition.variableId) || vars.has(variableRoot(condition.variableId))) || (condition.valueRef && !(vars.has(condition.valueRef) || vars.has(variableRoot(condition.valueRef))))) issues.push({ entityId: ending.id, message: "Ending condition references a missing variable" });
    });
    ending.routeIds.forEach((id) => { if (!routeIds.has(id)) issues.push({ entityId: ending.id, message: `Ending references missing route "${id}"` }); });
    if (ending.enabled && !endingDefinitionValid(ending, routeIds, vars)) issues.push({ entityId: ending.id, message: "Enabled ending is incomplete or invalid" });
  }
  return issues;
}

export function storyPromptBlock(world: WorldDefinition, state: GameState): string {
  if (world.settings?.storyStructureEnabled === false) return "";
  const guidance = state.story?.route?.guidance?.trim();
  return guidance ? `<active-route-guidance>\n${guidance}\n</active-route-guidance>` : "";
}
