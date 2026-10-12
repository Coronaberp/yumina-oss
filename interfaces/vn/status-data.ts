export type StatusGroup = string;
export type StatusCategory = { id: string; label: string };
export const defaultStatusCategories: StatusCategory[] = [{ id: "overview", label: "Overview" }, { id: "character", label: "Character" }, { id: "inventory", label: "Inventory" }];
export type StatusFormat = "value" | "bar" | "segments" | "badges" | "inventory" | "gauge" | "resource" | "chips" | "pips" | "xp-ring" | "scene";
export type StatusField = {
  id: string;
  label: string;
  variableId: string;
  path: string;
  group: StatusGroup;
  format: StatusFormat;
  icon: string;
  color: string;
  min: number;
  max: number;
  maxVariableId: string;
  maxPath: string;
  gaugeShape: "quarter" | "half" | "full";
  pipShape: "heart" | "star" | "diamond";
  pipCount: number;
  levelVariableId: string;
  levelPath: string;
  sceneIcon: "auto" | "field";
};
export type StatusConfig = { title: string; subtitle: string; accent: string; groups: StatusCategory[]; fields: StatusField[] };

const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
export function statusColor(value: unknown, fallback = "#c8b17e"): string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
}

/** Data only. Imported card configuration never executes in the editor preview. */
export function normalizeStatusConfig(value: unknown): StatusConfig {
  const config = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const accent = statusColor(config.accent);
  const groups: StatusCategory[] = [];
  for (const value of Array.isArray(config.groups) ? config.groups.slice(0, 24) : defaultStatusCategories) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const id = string(item.id).trim().slice(0, 64);
    if (!id || groups.some(group => group.id === id)) continue;
    groups.push({ id, label: string(item.label, id).trim().slice(0, 80) || id });
  }
  if (!groups.length) groups.push(...defaultStatusCategories.map(group => ({ ...group })));
  const ids = new Set<string>();
  const fields = (Array.isArray(config.fields) ? config.fields : []).flatMap((value, index): StatusField[] => {
    if (!value || typeof value !== "object") return [];
    const field = value as Record<string, unknown>;
    let id = string(field.id, `field-${index}`);
    if (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const group = string(field.group, groups[0]!.id).trim().slice(0, 64) || groups[0]!.id;
    if (!groups.some(category => category.id === group)) groups.push({ id: group, label: group[0]!.toUpperCase() + group.slice(1).replace(/[-_]/g, " ") });
    return [{
      id, label: string(field.label, "Value"), variableId: string(field.variableId), path: string(field.path),
      group,
      format: ["bar", "segments", "badges", "inventory", "gauge", "resource", "chips", "pips", "xp-ring", "scene"].includes(string(field.format)) ? field.format as StatusFormat : "value",
      icon: string(field.icon).slice(0, 8), color: statusColor(field.color, accent),
      min: finite(field.min, 0), max: finite(field.max, 100),
      maxVariableId: string(field.maxVariableId), maxPath: string(field.maxPath),
      gaugeShape: field.gaugeShape === "quarter" || field.gaugeShape === "full" ? field.gaugeShape : "half",
      pipShape: field.pipShape === "star" || field.pipShape === "diamond" ? field.pipShape : "heart",
      pipCount: Math.max(1, Math.min(20, Math.round(finite(field.pipCount, 10)))),
      levelVariableId: string(field.levelVariableId), levelPath: string(field.levelPath),
      sceneIcon: field.sceneIcon === "field" ? "field" : "auto",
    }];
  });
  return { title: string(config.title, "Status"), subtitle: string(config.subtitle, "Current state"), accent, groups, fields };
}

/** IDs are literal keys; an optional path selects a nested JSON property. */
export function statusValue(variables: Record<string, unknown>, variableId: string, path = ""): unknown {
  if (!Object.hasOwn(variables, variableId)) return undefined;
  let value: unknown = variables[variableId];
  for (const key of path.split(".").filter(Boolean)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function statusRange(field: StatusField, variables: Record<string, unknown>) {
  const value = statusValue(variables, field.variableId, field.path);
  const bound = field.maxVariableId ? statusValue(variables, field.maxVariableId, field.maxPath) : field.max;
  const max = finite(bound, field.max);
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  const percent = numeric === null || max <= field.min ? 0 : Math.max(0, Math.min(100, (numeric - field.min) / (max - field.min) * 100));
  return { value: numeric, min: field.min, max, percent };
}

/** One meter: absolute magnitude fills pips; sign selects the fill color. */
export function statusPips(range: { value: number | null; min: number; max: number; percent: number }, pipCount: number) {
  const signed = range.min < 0 && range.max > 0;
  const count = Math.max(1, Math.min(20, Math.round(finite(pipCount, 10))));
  const value = range.value ?? 0;
  const negative = value < 0;
  const magnitude = signed ? Math.min(1, Math.abs(value) / Math.abs(negative ? range.min : range.max)) : range.percent / 100;
  const left = Math.floor(count / 2), right = count - left;
  return { signed, count, negative, filled: range.value === null ? 0 : Math.round(magnitude * count),
    // Compatibility for already authored layouts; the default widget uses one meter.
    left, right, negativeFilled: signed && negative ? Math.round(magnitude * left) : 0,
    positiveFilled: signed && !negative ? Math.round(magnitude * right) : 0,
  };
}

export function statusText(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function statusItems(value: unknown): Array<{ name: string; quantity?: string; icon?: string; expiring?: boolean }> {
  const item = (value: unknown, fallback: string) => {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const result: { name: string; quantity?: string; icon?: string; expiring?: boolean } = { name: statusText(record.name ?? record.label ?? fallback), quantity: record.quantity === undefined && record.count === undefined ? undefined : statusText(record.quantity ?? record.count) };
      if (typeof record.icon === "string") result.icon = record.icon.slice(0, 8);
      const remaining = record.remaining ?? record.expiresIn ?? record.turns;
      if (typeof remaining === "number" && Number.isFinite(remaining)) result.expiring = remaining <= 1;
      return result;
    }
    return { name: fallback || statusText(value), quantity: fallback ? statusText(value) : undefined };
  };
  if (Array.isArray(value)) return value.map((value, index) => item(value, typeof value === "object" ? `Item ${index + 1}` : ""));
  if (value && typeof value === "object") return Object.entries(value).filter(([, value]) => value !== false && value !== null).map(([name, value]) => item(value, name));
  if (typeof value === "string") return value.split(",").map(name => ({ name: name.trim() })).filter(item => item.name);
  return value === true ? [{ name: "Active" }] : [];
}
