import {
  getStoryValidationIssues,
  isVnInterface,
  readVnAssetMap,
  readVnOpeningScenes,
  type WorldDefinition,
  type VnAssetMap,
} from "@yumina/engine";
import { executeValidateWorld } from "./tool-executor.js";

export const VN_PERIODS = ["day", "evening", "night"] as const;
export type VnPeriod = (typeof VN_PERIODS)[number];
export type FindingSeverity = "error" | "warning" | "info";

export interface ProjectFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  entityId?: string;
  evidence?: string;
  fix?: string;
}

export interface ScenePeriodCoverage {
  sceneId: string;
  context: "global" | `opening:${string}`;
  presentPeriods: VnPeriod[];
  missingPeriods: VnPeriod[];
  assetRefs: string[];
  externalImageRefs: string[];
}

export interface CharacterCoverage {
  characterId: string;
  name: string;
  hasPortrait: boolean;
  portraitRef?: string;
  hasSprite: boolean;
  spriteRefs: string[];
  externalSpriteRefs: string[];
  hasLore: boolean;
  loreEntryIds: string[];
  portraitReference?: string;
}

interface ParsedVnAssets {
  isVn: boolean;
  scenes: VnAssetMap;
  openingScenes: Record<string, VnAssetMap>;
  sprites: VnAssetMap;
  issues: ProjectFinding[];
  readable: { scenes: boolean; sprites: boolean };
}

const unique = <T,>(items: T[]) => [...new Set(items)];
const assetRefPattern = /^@asset:[A-Za-z0-9_-]+$/;
const variableIdPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const variableRoot = (ref: string) => ref.split(/[.[\]]/, 1)[0] ?? ref;

function mapAssetRefs(value: string | Record<string, string> | undefined): string[] {
  if (typeof value === "string") return value.startsWith("@asset:") ? [value] : [];
  if (!value) return [];
  return unique(Object.values(value).filter((ref) => ref.startsWith("@asset:")));
}

function mapExternalImageRefs(value: string | Record<string, string> | undefined): string[] {
  const values = typeof value === "string" ? [value] : value ? Object.values(value) : [];
  return unique(values.filter((ref) => /^https?:\/\//i.test(ref)));
}

function mapImageRefs(value: string | Record<string, string> | undefined): string[] {
  return unique([...mapAssetRefs(value), ...mapExternalImageRefs(value)]);
}

function readVnAssets(world: WorldDefinition): ParsedVnAssets {
  const root = world.rootComponent;
  const isVn = isVnInterface(root);
  const files = root?.files ?? {};
  const scenesSource = files["scenes.ts"];
  const spritesSource = files["sprites.ts"];
  const parsed: ParsedVnAssets = {
    isVn,
    scenes: {},
    openingScenes: {},
    sprites: {},
    issues: [],
    readable: { scenes: !isVn, sprites: !isVn },
  };

  if (isVn && !scenesSource) {
    parsed.readable.scenes = false;
    parsed.issues.push({ severity: "error", code: "vn-scenes-file-missing", message: "VN interface is missing scenes.ts.", fix: "Restore the managed VN background map or its file." });
  } else if (scenesSource) {
    try {
      parsed.scenes = readVnAssetMap(scenesSource, "backgrounds");
      parsed.openingScenes = readVnOpeningScenes(scenesSource);
      parsed.readable.scenes = true;
    } catch (error) {
      parsed.readable.scenes = false;
      parsed.issues.push({ severity: "warning", code: "vn-scenes-map-unreadable", message: "Background assignments use custom or unsupported code and cannot be inspected safely.", evidence: error instanceof Error ? error.message : "Literal map parsing failed." });
    }
  }

  if (isVn && !spritesSource) {
    parsed.readable.sprites = false;
    parsed.issues.push({ severity: "error", code: "vn-sprites-file-missing", message: "VN interface is missing sprites.ts.", fix: "Restore the managed VN sprite map or its file." });
  } else if (spritesSource) {
    try {
      parsed.sprites = readVnAssetMap(spritesSource, "sprites");
      parsed.readable.sprites = true;
    } catch (error) {
      parsed.readable.sprites = false;
      parsed.issues.push({ severity: "warning", code: "vn-sprites-map-unreadable", message: "Sprite assignments use custom or unsupported code and cannot be inspected safely.", evidence: error instanceof Error ? error.message : "Literal map parsing failed." });
    }
  }
  return parsed;
}

function hasSprite(value: string | Record<string, string> | undefined): boolean {
  return typeof value === "string" ? value.trim().length > 0 : !!value && Object.values(value).some((ref) => ref.trim().length > 0);
}

function scenePeriodCoverage(vn: ParsedVnAssets): ScenePeriodCoverage[] {
  if (!vn.readable.scenes) return [];
  const scenes = new Set([...Object.keys(vn.scenes), ...Object.values(vn.openingScenes).flatMap((map) => Object.keys(map))]);
  scenes.delete("default");
  const rows: ScenePeriodCoverage[] = [];
  const contexts: Array<{ id: "global" | `opening:${string}`; map?: VnAssetMap }> = [
    { id: "global" },
    ...Object.entries(vn.openingScenes).map(([id, map]) => ({ id: `opening:${id}` as const, map })),
  ];
  for (const context of contexts) {
    for (const sceneId of scenes) {
      const assigned = context.map && Object.hasOwn(context.map, sceneId) ? context.map[sceneId] : vn.scenes[sceneId];
      if (assigned === undefined) continue;
      const values = typeof assigned === "string" ? {} : assigned;
      const presentPeriods = VN_PERIODS.filter((period) => typeof values[period] === "string" && values[period]!.trim().length > 0);
      rows.push({
        sceneId,
        context: context.id,
        presentPeriods: [...presentPeriods],
        missingPeriods: VN_PERIODS.filter((period) => !presentPeriods.includes(period)),
        assetRefs: mapAssetRefs(assigned),
        externalImageRefs: mapExternalImageRefs(assigned),
      });
    }
  }
  return rows;
}

export function getScenePeriodCoverage(world: WorldDefinition): ScenePeriodCoverage[] {
  return scenePeriodCoverage(readVnAssets(world));
}

function characterCoverage(world: WorldDefinition, vn: ParsedVnAssets): CharacterCoverage[] {
  const characters = world.entries.filter((entry) => entry.role === "character");
  const loreEntries = world.entries.filter((entry) => entry.role === "lore" || entry.role === "plot");
  const spriteByName = new Map(Object.entries(vn.sprites).map(([name, value]) => [name.trim().toLocaleLowerCase(), value]));
  return characters.map((character) => {
    const sprite = spriteByName.get(character.name.trim().toLocaleLowerCase());
    const linkedLore = loreEntries.filter((entry) => entry.memory?.links?.some((link) => link.targetId === character.id));
    const directLore = character.content.trim().length > 0;
    return {
      characterId: character.id,
      name: character.name,
      hasPortrait: typeof character.portrait === "string" && character.portrait.trim().length > 0,
      ...(character.portrait?.startsWith("@asset:") ? { portraitRef: character.portrait } : {}),
      hasSprite: hasSprite(sprite),
      spriteRefs: mapAssetRefs(sprite),
      externalSpriteRefs: mapExternalImageRefs(sprite),
      hasLore: directLore || linkedLore.length > 0,
      loreEntryIds: [ ...(directLore ? [character.id] : []), ...linkedLore.map((entry) => entry.id) ],
      ...(character.portrait ? { portraitReference: character.portrait } : {}),
    };
  });
}

function endingEligibleForRoute(world: WorldDefinition, routeId: string, invalidEndingIds: Set<string>): boolean {
  return (world.endings ?? []).some((ending) => ending.enabled && !invalidEndingIds.has(ending.id)
    && (ending.routeIds.length === 0 || ending.routeIds.includes(routeId)));
}

export interface CompletenessReport {
  scenes: { total: number; missingVariantCount: number; missingVariants: ScenePeriodCoverage[]; truncated: boolean };
  characters: { total: number; missingPortrait: string[]; missingSprite: string[]; missingLore: string[]; coverage: CharacterCoverage[] };
  routes: { total: number; uncoveredEnabled: string[]; disabled: string[]; coverage: Array<{ routeId: string; enabled: boolean; hasEnding: boolean }> };
  findings: ProjectFinding[];
}

export function getProjectCompleteness(world: WorldDefinition): CompletenessReport {
  const vn = readVnAssets(world);
  const sceneRows = scenePeriodCoverage(vn);
  const characters = characterCoverage(world, vn);
  const routes = world.routes ?? [];
  const findings: ProjectFinding[] = [...vn.issues];
  const missingVariants = sceneRows.filter((row) => row.missingPeriods.length > 0);
  const invalidEndingIds = new Set(getStoryValidationIssues(world).map((issue) => issue.entityId));
  const routeCoverage = routes.map((route) => ({ routeId: route.id, enabled: route.enabled, hasEnding: endingEligibleForRoute(world, route.id, invalidEndingIds) }));
  const uncoveredEnabled = routeCoverage.filter((route) => route.enabled && !route.hasEnding).map((route) => route.routeId);
  if (missingVariants.length) findings.push({ severity: "warning", code: "scene-periods-missing", message: `${missingVariants.length} scene/context assignment(s) are missing one or more explicit time periods.`, evidence: "The report checks literal day/evening/night keys. Scalar assignments and runtime day fallbacks do not count as distinct variants." });
  if (characters.some((character) => !character.hasPortrait || !character.hasSprite || !character.hasLore)) findings.push({ severity: "warning", code: "character-coverage-incomplete", message: "One or more characters are missing a portrait, sprite, or lore entry." });
  if (uncoveredEnabled.length) findings.push({ severity: "warning", code: "route-without-ending", message: `${uncoveredEnabled.length} enabled route(s) have no eligible enabled ending.`, evidence: "An enabled global ending with an empty routeIds list covers every route; arbitrary condition satisfiability is not evaluated." });
  return {
    scenes: { total: sceneRows.length, missingVariantCount: missingVariants.length, missingVariants: missingVariants.slice(0, 100), truncated: missingVariants.length > 100 },
    characters: {
      total: characters.length,
      missingPortrait: characters.filter((character) => !character.hasPortrait).map((character) => character.characterId),
      missingSprite: characters.filter((character) => !character.hasSprite).map((character) => character.characterId),
      missingLore: characters.filter((character) => !character.hasLore).map((character) => character.characterId),
      coverage: characters,
    },
    routes: { total: routes.length, uncoveredEnabled, disabled: routes.filter((route) => !route.enabled).map((route) => route.id), coverage: routeCoverage },
    findings,
  };
}

export type VisualAuditKind = "characters" | "backgrounds";
export interface VisualAuditInput {
  subjectId: string;
  subjectName: string;
  role: string;
  assetRef?: string;
  uninspectableReference?: string;
  inspectable: boolean;
  description: string;
}

export function getVisualAuditInputs(world: WorldDefinition, kind: VisualAuditKind, offset = 0, limit = 20) {
  const vn = readVnAssets(world);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  const all: VisualAuditInput[] = kind === "characters"
    ? characterCoverage(world, vn).flatMap((character) => {
        const description = world.entries.find((entry) => entry.id === character.characterId)?.content.slice(0, 4000) ?? "";
        return [
          ...(character.portraitReference ? [{ subjectId: character.characterId, subjectName: character.name, role: "portrait", ...(character.portraitRef ? { assetRef: character.portraitRef } : { uninspectableReference: character.portraitReference }), inspectable: !!character.portraitRef && assetRefPattern.test(character.portraitRef), description }] : []),
          ...character.spriteRefs.map((assetRef) => ({ subjectId: character.characterId, subjectName: character.name, role: "sprite", assetRef, inspectable: assetRefPattern.test(assetRef), description })),
          ...character.externalSpriteRefs.map((reference) => ({ subjectId: character.characterId, subjectName: character.name, role: "sprite", uninspectableReference: reference, inspectable: false, description })),
        ];
      })
    : [
        ...scenePeriodCoverage(vn).flatMap((scene) => [
          ...scene.assetRefs.map((assetRef) => ({ subjectId: scene.sceneId, subjectName: scene.sceneId, role: `${scene.context}:${scene.presentPeriods.join(",") || "unlabeled"}`, assetRef, inspectable: assetRefPattern.test(assetRef), description: "" })),
          ...scene.externalImageRefs.map((reference) => ({ subjectId: scene.sceneId, subjectName: scene.sceneId, role: `${scene.context}:external`, uninspectableReference: reference, inspectable: false, description: "" })),
        ]),
        ...mapImageRefs(vn.scenes.default).map((reference) => ({ subjectId: "default", subjectName: "Global default", role: "global-default", ...(reference.startsWith("@asset:") ? { assetRef: reference } : { uninspectableReference: reference }), inspectable: assetRefPattern.test(reference), description: "" })),
        ...Object.entries(vn.openingScenes).flatMap(([openingId, map]) => mapImageRefs(map.default).map((reference) => ({ subjectId: openingId, subjectName: `Opening ${openingId} default`, role: "opening-default", ...(reference.startsWith("@asset:") ? { assetRef: reference } : { uninspectableReference: reference }), inspectable: assetRefPattern.test(reference), description: "" }))),
      ];
  const uninspectableCount = all.filter((item) => !item.inspectable).length;
  return { kind, total: all.length, offset: safeOffset, limit: safeLimit, hasMore: safeOffset + safeLimit < all.length, items: all.slice(safeOffset, safeOffset + safeLimit), uninspectableCount, limitations: vn.issues.filter((issue) => issue.code.includes("unreadable")) };
}

export interface DependencyNode { id: string; type: string; label: string }
export interface DependencyEdge { source: string; target: string; relation: string; provenance: "direct" | "inferred"; evidence: string }

export function getDependencyGraph(world: WorldDefinition, offset = 0, limit = 80) {
  const vn = readVnAssets(world);
  const nodes = new Map<string, DependencyNode>();
  const edges = new Map<string, DependencyEdge>();
  const node = (type: string, id: string, label: string) => {
    const key = `${type}:${id}`;
    nodes.set(key, { id: key, type, label });
    return key;
  };
  const edge = (source: string, target: string, relation: string, provenance: DependencyEdge["provenance"], evidence: string) => {
    const key = `${source}\0${target}\0${relation}`;
    edges.set(key, { source, target, relation, provenance, evidence });
  };
  const assetNode = (ref: string) => node("asset", ref, ref);
  const allEntries = world.entries ?? [];
  const variables = new Map(world.variables.map((variable) => [variable.id, variable]));
  const varNode = (id: string) => node("variable", id, variables.get(id)?.name ?? id);
  const entryNodeById = new Map(allEntries.map((entry) => [entry.id, node(entry.role === "character" ? "character" : entry.role === "lore" || entry.role === "plot" ? "lore" : "entry", entry.id, entry.name)]));

  for (const [sceneId, assigned] of Object.entries(vn.scenes)) {
    if (sceneId === "default") {
      const source = node("scene", "global:default", "Global default background");
      for (const ref of mapImageRefs(assigned)) edge(source, assetNode(ref), "background-default", "direct", "scenes.ts scenes.default");
      continue;
    }
    const source = node("scene", `global:${sceneId}`, `${sceneId} (Global)`);
    for (const ref of mapImageRefs(assigned)) edge(source, assetNode(ref), "background", "direct", `scenes.ts scenes.${sceneId}`);
  }
  for (const [openingId, map] of Object.entries(vn.openingScenes)) {
    for (const [sceneId, assigned] of Object.entries(map)) {
      if (sceneId === "default") {
        const source = node("scene", `${openingId}:default`, `Default background (opening ${openingId})`);
        for (const ref of mapImageRefs(assigned)) edge(source, assetNode(ref), "background-default", "direct", `scenes.ts openingScenes.${openingId}.default`);
        continue;
      }
      const source = node("scene", `${openingId}:${sceneId}`, `${sceneId} (opening ${openingId})`);
      for (const ref of mapImageRefs(assigned)) edge(source, assetNode(ref), "background", "direct", `scenes.ts openingScenes.${openingId}.${sceneId}`);
      const opening = entryNodeById.get(openingId);
      if (opening) edge(source, opening, "opening", "direct", `openingScenes key matches greeting entry ID ${openingId}`);
    }
  }

  for (const character of allEntries.filter((entry) => entry.role === "character")) {
    const source = entryNodeById.get(character.id)!;
    if (typeof character.portrait === "string" && (/^@asset:/.test(character.portrait) || /^https?:\/\//i.test(character.portrait))) edge(source, assetNode(character.portrait), "portrait", "direct", `entry ${character.id}.portrait`);
    const assigned = Object.entries(vn.sprites).find(([name]) => name.trim().toLocaleLowerCase() === character.name.trim().toLocaleLowerCase());
    for (const ref of mapImageRefs(assigned?.[1])) edge(source, assetNode(ref), "sprite", "direct", `sprites.ts key ${assigned?.[0]}`);
  }

  for (const entry of allEntries) {
    const source = entryNodeById.get(entry.id)!;
    for (const link of entry.memory?.links ?? []) {
      const target = entryNodeById.get(link.targetId);
      if (target) edge(source, target, "lore-link", "direct", `memory.links targetId=${link.targetId}${link.label ? ` (${link.label})` : ""}`);
    }
    for (const condition of entry.conditions ?? []) {
      const root = variableRoot(condition.variableId);
      if (variables.has(root)) edge(source, varNode(root), "condition", "direct", `entry ${entry.id} condition variableId=${condition.variableId}`);
      if (condition.valueRef && variables.has(variableRoot(condition.valueRef))) edge(source, varNode(variableRoot(condition.valueRef)), "value-reference", "direct", `entry ${entry.id} condition valueRef=${condition.valueRef}`);
    }
    for (const match of entry.content.matchAll(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g)) {
      const ref = match[1]!;
      const root = variableRoot(ref);
      if (variables.has(root)) edge(source, varNode(root), "template-variable", "direct", `entry ${entry.id} contains {{${ref}}}`);
    }
  }

  const addConditionEdges = (source: string, conditions: Array<{ variableId: string; valueRef?: string }>, evidence: string) => {
    for (const condition of conditions) {
      const root = variableRoot(condition.variableId);
      if (variables.has(root)) edge(source, varNode(root), "condition", "direct", `${evidence} variableId=${condition.variableId}`);
      if (condition.valueRef && variables.has(variableRoot(condition.valueRef))) edge(source, varNode(variableRoot(condition.valueRef)), "value-reference", "direct", `${evidence} valueRef=${condition.valueRef}`);
    }
  };
  for (const route of world.routes ?? []) {
    const source = node("route", route.id, route.name);
    addConditionEdges(source, route.conditions, `route ${route.id}`);
  }
  for (const ending of world.endings ?? []) {
    const source = node("ending", ending.id, ending.name);
    addConditionEdges(source, ending.conditions, `ending ${ending.id}`);
    for (const routeId of ending.routeIds) edge(source, node("route", routeId, world.routes?.find((route) => route.id === routeId)?.name ?? routeId), "eligible-route", "direct", `ending ${ending.id}.routeIds`);
  }

  // Name mentions are useful navigation hints, but never treated as authored links.
  const cast = allEntries.filter((entry) => entry.role === "character" && entry.name.trim().length > 1);
  for (const lore of allEntries.filter((entry) => entry.role === "lore" || entry.role === "plot")) {
    for (const character of cast) {
      if (lore.memory?.links?.some((link) => link.targetId === character.id)) continue;
      const matcher = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(character.name.trim())}([^\\p{L}\\p{N}_]|$)`, "iu");
      if (matcher.test(lore.content)) edge(entryNodeById.get(lore.id)!, entryNodeById.get(character.id)!, "name-mention", "inferred", `whole-name mention in lore entry ${lore.id}`);
    }
  }

  const allEdges = [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.relation.localeCompare(b.relation));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const page = allEdges.slice(safeOffset, safeOffset + safeLimit);
  const pageNodeIds = new Set(page.flatMap((item) => [item.source, item.target]));
  return {
    totalNodes: nodes.size,
    totalEdges: allEdges.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: safeOffset + page.length < allEdges.length ? safeOffset + page.length : null,
    nodes: [...nodes.values()].filter((item) => pageNodeIds.has(item.id)),
    edges: page,
    analysisLimitations: vn.issues.filter((issue) => issue.code.includes("unreadable")),
  };
}

export function getStructuralPreflight(world: WorldDefinition) {
  const vn = readVnAssets(world);
  const completeness = getProjectCompleteness(world);
  const validation = executeValidateWorld(world);
  const findings: ProjectFinding[] = validation.issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    entityId: issue.entity.id,
    fix: issue.fix,
  }));
  findings.push(...vn.issues);
  for (const variable of world.variables) {
    if (!variableIdPattern.test(variable.id)) findings.push({ severity: "error", code: "invalid-variable-id", entityId: variable.id, message: `Variable ID "${variable.id}" is not a valid identifier.`, fix: "Use a letter followed by letters, numbers, hyphens, or underscores." });
  }
  const seenVariables = new Set<string>();
  for (const variable of world.variables) {
    if (seenVariables.has(variable.id)) findings.push({ severity: "error", code: "duplicate-variable-id", entityId: variable.id, message: `Variable ID "${variable.id}" is declared more than once.` });
    seenVariables.add(variable.id);
  }
  const greetings = new Set(world.entries.filter((entry) => entry.role === "greeting").map((entry) => entry.id));
  for (const openingId of Object.keys(vn.openingScenes)) {
    if (!greetings.has(openingId)) findings.push({ severity: "warning", code: "opening-scene-reference-missing", entityId: openingId, message: `openingScenes references "${openingId}", but no greeting entry has that ID.`, fix: "Rename the openingScenes key to a greeting entry ID or remove the unused map." });
  }
  if (completeness.routes.uncoveredEnabled.length) findings.push({ severity: "warning", code: "route-ending-uncovered", message: `${completeness.routes.uncoveredEnabled.length} enabled route(s) have no eligible enabled ending.`, evidence: "An enabled ending with an empty routeIds list is global. This scan does not solve arbitrary route/ending condition satisfiability." });
  if (completeness.scenes.missingVariantCount) findings.push({ severity: "warning", code: "scene-periods-incomplete", message: `${completeness.scenes.missingVariantCount} scene/context assignment(s) lack explicit day/evening/night variants.`, evidence: "The runtime may fall back to another image, but that does not establish three authored variants." });
  const deduped = [...new Map(findings.map((finding) => [`${finding.code}:${finding.entityId ?? ""}:${finding.message}`, finding])).values()];
  return {
    clean: !deduped.some((finding) => finding.severity === "error"),
    blockingErrors: deduped.filter((finding) => finding.severity === "error"),
    warnings: deduped.filter((finding) => finding.severity !== "error"),
    assetRefs: unique([
      ...completeness.characters.coverage.flatMap((character) => [...character.spriteRefs, ...(character.portraitRef ? [character.portraitRef] : [])]),
      ...Object.values(vn.sprites).flatMap((value) => mapAssetRefs(value)),
      ...Object.values(vn.scenes).flatMap((value) => mapAssetRefs(value)),
      ...Object.values(vn.openingScenes).flatMap((map) => Object.values(map).flatMap((value) => mapAssetRefs(value))),
    ]),
    analysisComplete: vn.readable.scenes && vn.readable.sprites,
  };
}

export function inspectStudioWorld(world: WorldDefinition) {
  const vn = readVnAssets(world);
  return {
    completeness: getProjectCompleteness(world),
    dependencyGraph: getDependencyGraph(world, 0, 80),
    visualAudit: {
      available: vn.readable.scenes && vn.readable.sprites,
      limitations: vn.issues,
      characterImageCount: getVisualAuditInputs(world, "characters").total,
      backgroundImageCount: getVisualAuditInputs(world, "backgrounds").total,
      instruction: "These are comparison inputs only. Use view_image on each listed @asset before claiming a visual mismatch; report uninspected items as unchecked.",
    },
    preflight: getStructuralPreflight(world),
  };
}
