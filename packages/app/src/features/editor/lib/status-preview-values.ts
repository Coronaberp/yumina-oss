import { checkConditions, evaluateCondition, type GameState, type Variable } from "@yumina/engine";

/** Prevent large pasted values from overwhelming a temporary preview editor. */
export const STATUS_PREVIEW_INPUT_LIMIT = 65_536;
export type PreviewParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** IDs are literal keys. Include internal/disabled variables; only presentation changes. */
export function statusPreviewValues(variables: Variable[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(variables.map(variable => [variable.id,
    Object.hasOwn(overrides, variable.id) ? overrides[variable.id] : variable.defaultValue,
  ]));
}

export function statusPreviewValue(variable: Variable, values: Record<string, unknown>, overrides: Record<string, unknown>): unknown {
  return Object.hasOwn(overrides, variable.id) ? overrides[variable.id]
    : Object.hasOwn(values, variable.id) ? values[variable.id] : variable.defaultValue;
}

export function formatStatusPreviewInput(type: Variable["type"], value: unknown): string {
  if (type === "json") return JSON.stringify(value, null, 2) ?? "";
  if (type === "boolean") return value === true ? "true" : value === false ? "false" : "";
  return value === undefined || value === null ? "" : String(value);
}

/** No defaults, bounds or variable definitions are changed or coerced here. */
export function parseStatusPreviewInput(type: Variable["type"], source: string): PreviewParseResult {
  if (source.length > STATUS_PREVIEW_INPUT_LIMIT) return { ok: false, error: `Use at most ${STATUS_PREVIEW_INPUT_LIMIT.toLocaleString("en-US")} characters.` };
  if (type === "string") return { ok: true, value: source };
  if (type === "boolean") {
    if (source === "true" || source === "false") return { ok: true, value: source === "true" };
    return { ok: false, error: "Choose true or false." };
  }
  if (type === "number") {
    const trimmed = source.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(Number(trimmed))) {
      return { ok: false, error: "Enter a finite number." };
    }
    return { ok: true, value: Number(trimmed) };
  }
  try { return { ok: true, value: JSON.parse(source) }; }
  catch { return { ok: false, error: "Enter valid JSON. The preview keeps its last valid value." }; }
}

export function setStatusPreviewOverride(overrides: Record<string, unknown>, id: string, value: unknown): Record<string, unknown> {
  return { ...overrides, [id]: value };
}
export function clearStatusPreviewOverride(overrides: Record<string, unknown>, id: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== id));
}

export function filterStatusPreviewVariables(variables: Variable[], query: string): Variable[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return variables.filter(variable => {
    const text = `${variable.name} ${variable.id} ${variable.type} ${variable.description ?? ""} ${variable.internal ? "internal hidden" : ""} ${variable.enabled === false ? "disabled" : ""}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

function previewPathValue(values: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(values, path)) return values[path];
  let current: unknown = values;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Explain authored activation gates without running gameplay rules or custom code.
 * The optional shortcut is explicit, atomic and restricted to literal equality.
 * It patches declared values only; JSON ancestors must already exist. */
export function statusPreviewRequirements(variable: Variable, variables: Variable[], values: Record<string, unknown>) {
  const activation = variable.activation;
  const source = activation?.mode === "conditions" ? activation.conditions : [];
  // These engine evaluators read only variables for condition-based activation.
  const state = { variables: values } as GameState;
  const conditions = source.map(condition => ({ condition, current: previewPathValue(values, condition.variableId),
    target: condition.valueRef !== undefined ? previewPathValue(values, condition.valueRef) : condition.value,
    satisfied: evaluateCondition(state, condition) }));
  const active = activation?.mode !== "conditions" || checkConditions(state, source, activation.conditionLogic);
  const manual = { active, conditions, overrides: null as Record<string, unknown> | null };
  if (active || activation?.mode !== "conditions" || activation.conditionLogic !== "all" || source.length > 128) return manual;

  let working = values;
  const overrides: Record<string, unknown> = {};
  const targets: { keys: string[]; value: unknown }[] = [];
  for (const condition of source) {
    const target = condition.value;
    if (condition.operator !== "eq" || condition.valueRef !== undefined
      || !["string", "number", "boolean"].includes(typeof target)
      || typeof target === "number" && !Number.isFinite(target)) return manual;
    const path = condition.variableId.split(".");
    if (path.length > 64 || path.some(key => !key || ["__proto__", "prototype", "constructor"].includes(key))) return manual;
    // Match engine lookup: an exact declared ID wins; otherwise start at the first segment.
    const root = variables.find(item => item.id === condition.variableId) ?? variables.find(item => item.id === path[0]);
    if (!root || root.id === variable.id) return manual;
    const parts = root.id === condition.variableId ? [] : path.slice(1);
    const keys = [root.id, ...parts];
    for (const prior of targets) {
      const overlaps = keys.slice(0, Math.min(keys.length, prior.keys.length)).every((key, index) => key === prior.keys[index]);
      if (overlaps && (keys.length !== prior.keys.length || target !== prior.value)) return manual;
    }
    targets.push({ keys, value: target });
    if (evaluateCondition({ variables: working } as GameState, condition)) continue;
    let next: unknown = target;
    if (!parts.length) {
      if (root.type !== typeof target) return manual;
    } else {
      if (root.type !== "json") return manual;
      let current = working[root.id];
      const ancestors: Record<string, unknown>[] = [];
      for (let index = 0; index < parts.length; index++) {
        if (!current || typeof current !== "object" || Array.isArray(current)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) return manual;
        ancestors.push(current as Record<string, unknown>);
        if (index < parts.length - 1) {
          if (!Object.hasOwn(current, parts[index]!)) return manual;
          current = (current as Record<string, unknown>)[parts[index]!];
        }
      }
      for (let index = parts.length - 1; index >= 0; index--) next = { ...ancestors[index], [parts[index]!]: next };
    }
    Object.defineProperty(overrides, root.id, { value: next, enumerable: true, configurable: true, writable: true });
    working = { ...working, [root.id]: next };
  }
  return checkConditions({ variables: working } as GameState, source, "all") ? { active, conditions, overrides } : manual;
}

function readablePreviewName(value: string): string {
  return value.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[._-]+/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function previewRequirementName(path: string, variables: Variable[]): string {
  const exact = variables.find(variable => variable.id === path);
  if (exact) return exact.name || readablePreviewName(path);
  const [root, ...parts] = path.split(".");
  const variable = variables.find(variable => variable.id === root);
  return [variable?.name || readablePreviewName(root ?? ""), ...parts.map(readablePreviewName)].join(" / ");
}

function readablePreviewValue(value: unknown): string {
  if (value === undefined) return "not set";
  if (value === null) return "empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value ? `“${value}”` : "blank";
  if (Array.isArray(value)) return `a list with ${value.length} items`;
  if (typeof value === "object") return "a set of details";
  return String(value);
}

/** Human-facing explanation; retain exact IDs in the editor's separate ID labels. */
export function describeStatusPreviewRequirement({ condition, current, target }: ReturnType<typeof statusPreviewRequirements>["conditions"][number], variables: Variable[]): string {
  const parts = condition.variableId.split(".");
  if (!variables.some(variable => variable.id === condition.variableId) && parts.length === 3 && parts[1] === "met"
    && condition.operator === "eq" && condition.valueRef === undefined && typeof target === "boolean") {
    const name = readablePreviewName(parts[2]!);
    if (target && current === false) return `${name} hasn’t been met in this preview.`;
    return `Mark ${name} as ${target ? "met" : "not met"} to show this item.`;
  }
  const label = previewRequirementName(condition.variableId, variables);
  const expected = condition.valueRef !== undefined
    ? `the value of ${previewRequirementName(condition.valueRef, variables)} (${readablePreviewValue(target)})`
    : readablePreviewValue(target);
  const operator = { eq: "be", neq: "be different from", gt: "be more than", gte: "be at least", lt: "be less than", lte: "be at most", contains: "include" }[condition.operator];
  return `${label} needs to ${operator} ${expected}. It is currently ${readablePreviewValue(current)}.`;
}
