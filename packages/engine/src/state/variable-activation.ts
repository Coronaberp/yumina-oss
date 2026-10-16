import type { Effect, GameState, Variable, WorldDefinition } from "../types/index.js";
import { checkConditions } from "./condition-evaluator.js";

/**
 * Variable activation + AI-access resolution — the single authority every
 * consumer (prompt-builder, directive filter, GamePanel/resolveComponents)
 * goes through, mirroring computeActiveWorldbookIds for worldbooks.
 *
 * Core rule: a variable's VALUE always exists regardless of activation.
 * Conditions, reactions and the sandbox keep reading values as before —
 * activation only gates exposure (prompt / player UI) and AI writability.
 * Evaluating activation conditions against raw values (never against the
 * other variable's own activation) is what keeps mutual bindings cycle-free.
 */

/** Whether the variable is currently active (exposed + gate-able). */
export function isVariableActive(variable: Variable, state: GameState): boolean {
  // Enable gate: runtime toggle (via @vars.enabled.<id>) beats the authored
  // default, in both directions. Applies to every activation mode.
  const toggle = state.ruleState?.toggledVariables?.[variable.id];
  const gateOn = toggle ?? variable.enabled !== false;
  if (!gateOn) return false;

  const activation = variable.activation;
  if (!activation) return true; // undefined = always
  switch (activation.mode) {
    case "always":
    case "manual": // manual = no auto-rule; the enable gate above is the rule
      return true;
    case "conditions":
      return checkConditions(state, activation.conditions, activation.conditionLogic);
    case "greeting": {
      const current = String(state.activeGreetingId ?? "");
      return current !== "" && activation.greetingIds.includes(current);
    }
    default:
      return true;
  }
}

/** Whether the AI should see this variable in <game-state> / behavior rules. */
export function isAiReadable(variable: Variable, state: GameState): boolean {
  if (variable.internal) return false;
  if (!isVariableActive(variable, state)) return false;
  return (variable.aiAccess ?? "write") !== "none";
}

/** Whether AI directives may change this variable. */
export function isAiWritable(variable: Variable, state: GameState): boolean {
  if (variable.internal) return false;
  if (!isVariableActive(variable, state)) return false;
  return (variable.aiAccess ?? "write") === "write";
}

/** Active variable ids for a world — for UI layers that filter by id. */
export function resolveActiveVariableIds(
  world: WorldDefinition,
  state: GameState,
): Set<string> {
  const active = new Set<string>();
  for (const v of world.variables) {
    if (isVariableActive(v, state)) active.add(v.id);
  }
  return active;
}

/** Match state-manager lookup: IDs first, then the last matching display name.
 * Nested paths are rooted in an ID, including bracket-indexed arrays. */
export function resolveEffectVariable(
  world: Pick<WorldDefinition, "variables">,
  variableId: string,
): Variable | undefined {
  if (variableId.includes(".") || /\[\d+\]/.test(variableId)) {
    const root = variableId.replace(/\[(\d+)\]/g, ".$1").split(".")[0];
    return world.variables.find((variable) => variable.id === root);
  }
  const byId = world.variables.find((variable) => variable.id === variableId);
  if (byId) return byId;
  for (let index = world.variables.length - 1; index >= 0; index--) {
    if (world.variables[index]!.name === variableId) return world.variables[index];
  }
  return undefined;
}

/**
 * Split AI-issued effects into those targeting AI-writable variables (kept)
 * and those the AI is not allowed to change (dropped). Dot-paths resolve by
 * their root id. Unknown ids pass through — the existing unknown-variable
 * guard in GameStateManager owns that case (and its logging).
 */
export function filterAiEffects(
  world: WorldDefinition,
  state: GameState,
  effects: Effect[],
): { kept: Effect[]; dropped: Effect[] } {
  const kept: Effect[] = [];
  const dropped: Effect[] = [];
  for (const effect of effects) {
    const variable = resolveEffectVariable(world, effect.variableId);
    if (!variable || isAiWritable(variable, state)) {
      kept.push(effect);
    } else {
      dropped.push(effect);
    }
  }
  return { kept, dropped };
}
