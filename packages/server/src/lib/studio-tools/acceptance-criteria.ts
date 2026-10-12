import type { WorldDefinition } from "@yumina/engine";
import { getProjectCompleteness, getScenePeriodCoverage, getStructuralPreflight, type VnPeriod } from "./project-intelligence.js";

export interface StudioAcceptanceCriteria {
  scenePeriods?: { periods: VnPeriod[]; scope?: "global" | "all-contexts" };
  characterCoverage?: { portrait?: boolean; sprite?: boolean; lore?: boolean };
  requiredVariableIds?: string[];
  cleanPreflight?: boolean;
}

export interface StudioAcceptanceStatus {
  active: boolean;
  met: boolean;
  checkedAt: string;
  unmet: string[];
  criteria: StudioAcceptanceCriteria;
}

const periods = new Set<VnPeriod>(["day", "evening", "night"]);
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function normalizeAcceptanceCriteria(input: unknown): StudioAcceptanceCriteria {
  if (!plainObject(input)) throw new Error("criteria must be an object.");
  const result: StudioAcceptanceCriteria = {};
  const keys = Object.keys(input);
  if (keys.some((key) => !["scenePeriods", "characterCoverage", "requiredVariableIds", "cleanPreflight"].includes(key))) {
    throw new Error("Unsupported acceptance criterion.");
  }
  if (input.scenePeriods !== undefined) {
    if (!plainObject(input.scenePeriods) || !Array.isArray(input.scenePeriods.periods) || input.scenePeriods.periods.length < 1
      || input.scenePeriods.periods.length > 3 || input.scenePeriods.periods.some((period) => !periods.has(period as VnPeriod))) {
      throw new Error("scenePeriods.periods must list day, evening, and/or night.");
    }
    if (input.scenePeriods.scope !== undefined && input.scenePeriods.scope !== "global" && input.scenePeriods.scope !== "all-contexts") throw new Error("scenePeriods.scope must be global or all-contexts.");
    result.scenePeriods = { periods: [...new Set(input.scenePeriods.periods as VnPeriod[])], scope: input.scenePeriods.scope as "global" | "all-contexts" | undefined };
  }
  if (input.characterCoverage !== undefined) {
    if (!plainObject(input.characterCoverage) || Object.entries(input.characterCoverage).some(([key, value]) => !["portrait", "sprite", "lore"].includes(key) || typeof value !== "boolean")) {
      throw new Error("characterCoverage supports portrait, sprite, and lore booleans.");
    }
    result.characterCoverage = input.characterCoverage as StudioAcceptanceCriteria["characterCoverage"];
  }
  if (input.requiredVariableIds !== undefined) {
    if (!Array.isArray(input.requiredVariableIds) || input.requiredVariableIds.length > 100
      || input.requiredVariableIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 100)) {
      throw new Error("requiredVariableIds must contain at most 100 non-empty IDs.");
    }
    result.requiredVariableIds = [...new Set(input.requiredVariableIds as string[])];
  }
  if (input.cleanPreflight !== undefined) {
    if (typeof input.cleanPreflight !== "boolean") throw new Error("cleanPreflight must be a boolean.");
    result.cleanPreflight = input.cleanPreflight;
  }
  return result;
}

export function readAcceptanceCriteria(context: Record<string, unknown> | null | undefined): StudioAcceptanceCriteria | null {
  const saved = context?.acceptanceCriteria;
  if (!plainObject(saved)) return null;
  try {
    const normalized = normalizeAcceptanceCriteria(saved);
    return Object.keys(normalized).length ? normalized : null;
  } catch {
    return null;
  }
}

export function evaluateAcceptanceCriteria(
  world: WorldDefinition,
  criteria: StudioAcceptanceCriteria,
  options?: { missingAssetRefs?: string[] },
): StudioAcceptanceStatus {
  const unmet: string[] = [];
  const coverage = getProjectCompleteness(world);
  if (criteria.scenePeriods) {
    const allRows = getScenePeriodCoverage(world);
    const rows = allRows.filter((row) => criteria.scenePeriods!.scope === "all-contexts" || row.context === "global");
    if (rows.length === 0) {
      unmet.push("No inspectable VN scene assignments were found for the requested period coverage.");
    } else {
      const requested = new Set(criteria.scenePeriods.periods);
      const incomplete = rows.filter((row) => row.presentPeriods.length < requested.size || [...requested].some((period) => !row.presentPeriods.includes(period)));
      if (incomplete.length) unmet.push(`${incomplete.length} scene/context assignment(s) are missing requested periods (${[...requested].join(", ")}).`);
    }
  }
  const requestedCharacterFields = Object.entries(criteria.characterCoverage ?? {}).filter(([, required]) => required).map(([field]) => field as "portrait" | "sprite" | "lore");
  for (const field of requestedCharacterFields) {
    const missing = coverage.characters.coverage.filter((character) => !character[field === "portrait" ? "hasPortrait" : field === "sprite" ? "hasSprite" : "hasLore"]);
    if (missing.length) unmet.push(`${missing.length} character(s) are missing ${field}: ${missing.map((character) => character.characterId).slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}.`);
  }
  if (criteria.requiredVariableIds?.length) {
    const declared = new Set(world.variables.map((variable) => variable.id));
    const missing = criteria.requiredVariableIds.filter((id) => !declared.has(id));
    if (missing.length) unmet.push(`Required variables are missing: ${missing.join(", ")}.`);
  }
  if (criteria.cleanPreflight) {
    const preflight = getStructuralPreflight(world);
    if (preflight.blockingErrors.length) unmet.push(`Preflight has ${preflight.blockingErrors.length} blocking error(s).`);
    if (options?.missingAssetRefs?.length) unmet.push(`Preflight found ${options.missingAssetRefs.length} unowned or missing image asset reference(s).`);
  }
  return { active: true, met: unmet.length === 0, checkedAt: new Date().toISOString(), unmet, criteria };
}

export function formatUnmetAcceptance(status: StudioAcceptanceStatus): string {
  return status.unmet.length ? `Acceptance criteria remain unmet:\n${status.unmet.map((item) => `- ${item}`).join("\n")}` : "All saved acceptance criteria are met.";
}
