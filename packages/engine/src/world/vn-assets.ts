import { displayCharacterName } from "../prompts/speaker-tag.js";
import type { RootComponent, WorldEntry } from "../types/index.js";

export type VnAssetKind = "sprites" | "backgrounds";
export type VnAssetMap = Record<string, string | Record<string, string>>;
export type VnAssetRow = { name: string; variant: string; assetRef: string };
export type VnOpeningScenes = Record<string, VnAssetMap>;
export type VnAssetOrders = Record<string, string[]>;
export const VN_ASSET_ORDER_FILE = "vn-asset-order.json";
export const vnAssetRowId = (row: VnAssetRow) => JSON.stringify([row.name, row.variant]);
export type NpcSpriteGender = "male" | "female";
export type VnNpcSpritePools = Record<NpcSpriteGender, Record<string, string>>;
export type NpcDefaultMode = "a" | "b";
export type VnNpcDefaults = { disabled: boolean; mode: NpcDefaultMode };
export const vnAssetFile = (kind: VnAssetKind) => kind === "sprites" ? "sprites.ts" : "scenes.ts";

/** Imported cards may organize characters by tag while retaining a custom role. */
export function vnCharacterNames(entries: ReadonlyArray<Pick<WorldEntry, "name" | "role" | "tags">>): string[] {
  const names = entries.filter(entry => entry.role === "character" || entry.tags?.some(tag => /^characters?$/i.test(tag.trim())))
    .map(entry => displayCharacterName(entry.name)).filter(Boolean);
  return [...new Set(names)];
}

export function isVnInterface(root?: RootComponent): boolean {
  if (!root || root.interfaceId === "classic") return false;
  if (root.interfaceId === "vn") return true;
  const source = root.files["__user-root.tsx"] ?? root.files[root.entryFile] ?? "";
  return !!root.files["sprites.ts"] && !!root.files["scenes.ts"] && /className=["']vn(?:-root)?["']/.test(source);
}

const invalid = () => new Error("This asset map is managed by custom code rather than a literal image map.");

/** A data-only reader: quoted strings and object literals, never executable JS. */
function literalMap(source: string, kind: VnAssetKind, binding = kind === "sprites" ? "sprites" : "scenes", maxDepth = 1) {
  const matches = [...source.matchAll(new RegExp(`^[ \\t]*export\\s+const\\s+${binding}\\s*=\\s*`, "gm"))];
  if (matches.length !== 1) throw invalid();
  const start = matches[0]!.index! + matches[0]![0].length;
  let cursor = start;
  const skip = () => {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor]!)) { cursor++; continue; }
      if (source.startsWith("//", cursor)) { cursor = source.indexOf("\n", cursor); if (cursor < 0) cursor = source.length; continue; }
      if (source.startsWith("/*", cursor)) { const end = source.indexOf("*/", cursor + 2); if (end < 0) throw invalid(); cursor = end + 2; continue; }
      break;
    }
  };
  const string = (): string => {
    const quote = source[cursor++];
    if (quote !== '"' && quote !== "'") throw invalid();
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === quote) return value;
      if (char === "\n" || char === "\r") throw invalid();
      if (char !== "\\") { value += char; continue; }
      const escaped = source[cursor++];
      if (escaped === undefined) throw invalid();
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", '"': '"', "'": "'", "/": "/" };
      if (escaped in escapes) value += escapes[escaped];
      else if (escaped === "u" || escaped === "x") {
        const length = escaped === "u" ? 4 : 2;
        const hex = source.slice(cursor, cursor + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw invalid();
        value += String.fromCharCode(parseInt(hex, 16)); cursor += length;
      } else throw invalid();
    }
    throw invalid();
  };
  const object = (depth: number): VnAssetMap | Record<string, string> => {
    if (depth > maxDepth || source[cursor++] !== "{") throw invalid();
    const entries: Array<[string, string | Record<string, string>]> = [];
    const keys = new Set<string>();
    skip();
    while (source[cursor] !== "}") {
      let key: string;
      if (source[cursor] === '"' || source[cursor] === "'") key = string();
      else { const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor)); if (!match) throw invalid(); key = match[0]; cursor += key.length; }
      if (keys.has(key)) throw invalid();
      keys.add(key); skip();
      if (source[cursor++] !== ":") throw invalid();
      skip();
      const value = source[cursor] === "{" ? object(depth + 1) as Record<string, string> : string();
      entries.push([key, value]); skip();
      if (source[cursor] === "}") break;
      if (source[cursor++] !== ",") throw invalid();
      skip();
    }
    cursor++;
    return Object.fromEntries(entries);
  };
  skip();
  const mapStart = cursor;
  const map = object(0) as VnAssetMap;
  const end = cursor;
  skip();
  if (cursor < source.length && source[cursor] !== ";") throw invalid();
  return { map, start: mapStart, end };
}

/** Transfer authored literal maps into refreshed helpers without evaluating code. */
export function preserveVnAssetConfiguration(source: string, template: string, kind: VnAssetKind): string {
  const bindings = kind === 'sprites'
    ? ['sprites', 'npcSprites', 'npcDefaultSpritesA', 'npcDefaultSpritesB']
    : ['scenes', 'openingScenes'];
  let result = template;
  for (const binding of bindings) {
    const declared = new RegExp(`^[ \\t]*export\\s+const\\s+${binding}\\s*=`, 'm').test(source);
    if (!declared && binding !== bindings[0]) continue;
    const depth = binding === 'openingScenes' ? 2 : 1;
    const saved = literalMap(source, kind, binding, depth);
    const target = literalMap(result, kind, binding, depth);
    result = result.slice(0, target.start) + JSON.stringify(saved.map, null, 2) + result.slice(target.end);
  }
  if (kind === 'sprites' && /\bnpcDefaults\b/.test(source)) result = writeVnNpcDefaults(result, readVnNpcDefaults(source));
  return result;
}

export function readVnAssetMap(source: string, kind: VnAssetKind): VnAssetMap {
  return literalMap(source, kind).map;
}

export function readVnOpeningScenes(source: string): VnOpeningScenes {
  if (!/\bopeningScenes\b/.test(source)) return {};
  const maps = literalMap(source, "backgrounds", "openingScenes", 2).map;
  for (const map of Object.values(maps)) {
    if (typeof map !== "object" || map === null) throw invalid();
    // Each opening uses the same data-only scene map as Global.
    readVnAssetMap(`export const scenes = ${JSON.stringify(map)};`, "backgrounds");
  }
  return maps as unknown as VnOpeningScenes;
}

/** Upgrade only the standard resolver; never overwrite authored background logic. */
export function writeVnOpeningScenes(source: string, openingId: string, map: VnAssetMap, template: string): string {
  if (!openingId) throw invalid();
  readVnAssetMap(`export const scenes = ${JSON.stringify(map)};`, "backgrounds");
  const maps = { ...readVnOpeningScenes(source), [openingId]: map };
  if (!Object.keys(map).length) delete maps[openingId];
  let result = source;
  if (!/\bopeningScenes\b/.test(source)) {
    const resolver = /export\s+function\s+backgroundFor\(api,\s*line\)\s*\{[^{}]*\}/;
    const current = resolver.exec(source)?.[0];
    const normalize = (value: string) => value.replace(/\s+/g, "");
    const old = `export function backgroundFor(api, line) {
      const scene = scenes[line?.scene || api.variables?.["current-scene"]];
      return (typeof scene === "string" ? scene : scene?.[api.variables?.["current-period"]] || scene?.day)
        || api.variables?.["scene-bg"] || api.variables?.scene_bg || api.variables?.current_bg;
    }`;
    const withDefault = old.replace('|| api.variables?.["scene-bg"]', '|| (typeof scenes.default === "string" ? scenes.default : scenes.default?.[api.variables?.["current-period"]] || scenes.default?.day) || api.variables?.["scene-bg"]');
    if (!current || ![old, withDefault].some(known => normalize(known) === normalize(current))) throw invalid();
    const replacement = template.slice(template.indexOf("export function backgroundFor"));
    if (!replacement.startsWith("export function backgroundFor") || !/\bopeningScenes\b/.test(replacement)) throw invalid();
    result = source.replace(current, replacement.trimEnd());
    result += `\nexport const openingScenes = ${JSON.stringify(maps, null, 2)};\n`;
  } else {
    const span = literalMap(source, "backgrounds", "openingScenes", 2);
    result = source.slice(0, span.start) + JSON.stringify(maps, null, 2) + source.slice(span.end);
  }
  readVnOpeningScenes(result);
  return result;
}

export function readVnAssetOrders(source?: string): VnAssetOrders {
  if (!source) return {};
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some(order => !Array.isArray(order) || order.some(id => typeof id !== "string") || new Set(order).size !== order.length)) throw invalid();
  return value as VnAssetOrders;
}

export function orderedVnAssetRows(rows: VnAssetRow[], order: readonly string[] = []): VnAssetRow[] {
  const byId = new Map(rows.map(row => [vnAssetRowId(row), row]));
  const result: VnAssetRow[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (row) { result.push(row); byId.delete(id); }
  }
  return result.concat([...byId.values()]);
}

/** Replace only visible slots so a character filter never moves hidden cards. */
export function reorderVnAssetRows(rows: VnAssetRow[], visibleRows: VnAssetRow[], activeId: string, overId: string): VnAssetRow[] {
  const ids = visibleRows.map(vnAssetRowId);
  const from = ids.indexOf(activeId), to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return rows;
  const moved = [...visibleRows];
  moved.splice(to, 0, moved.splice(from, 1)[0]!);
  const visible = new Set(ids);
  let index = 0;
  return rows.map(row => visible.has(vnAssetRowId(row)) ? moved[index++]! : row);
}

function readNpcPools(source: string, binding: string): VnNpcSpritePools {
  // Older authored interfaces have no pool binding. Their character map stays intact.
  if (!new RegExp(`\\b${binding}\\b`).test(source)) return { male: {}, female: {} };
  const map = literalMap(source, "sprites", binding).map;
  if (Object.keys(map).some(key => key !== "male" && key !== "female") ||
      Object.values(map).some(pool => typeof pool !== "object" || pool === null || Array.isArray(pool))) throw invalid();
  return { male: (map.male as Record<string, string>) ?? {}, female: (map.female as Record<string, string>) ?? {} };
}

export function readVnNpcSpritePools(source: string): VnNpcSpritePools {
  return readNpcPools(source, "npcSprites");
}

export function readVnNpcDefaultSpritePools(source: string, mode: NpcDefaultMode): VnNpcSpritePools {
  return readNpcPools(source, mode === "a" ? "npcDefaultSpritesA" : "npcDefaultSpritesB");
}

function npcDefaultsLiteral(source: string) {
  const declarations = [...source.matchAll(/^[ \t]*export\s+const\s+npcDefaults\s*=\s*/gm)];
  if (declarations.length !== 1) throw invalid();
  const start = declarations[0]!.index! + declarations[0]![0].length;
  const match = /^(\{[^{}]*\})\s*;/.exec(source.slice(start));
  if (!match) throw invalid();
  let value: unknown;
  try { value = JSON.parse(match[1]!); } catch { throw invalid(); }
  const defaults = value as VnNpcDefaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults) ||
      Object.keys(defaults).length !== 2 || typeof defaults.disabled !== "boolean" ||
      (defaults.mode !== "a" && defaults.mode !== "b")) throw invalid();
  return { defaults, start, end: start + match[1]!.length };
}

export function readVnNpcDefaults(source: string): VnNpcDefaults {
  if (!/\bnpcDefaults\b/.test(source)) return { disabled: false, mode: "b" };
  return npcDefaultsLiteral(source).defaults;
}

export function writeVnNpcDefaults(source: string, defaults: VnNpcDefaults): string {
  const serialized = JSON.stringify(defaults, null, 2);
  npcDefaultsLiteral(`export const npcDefaults = ${serialized};`);
  if (!/\bnpcDefaults\b/.test(source)) return source + `\nexport const npcDefaults = ${serialized};\n`;
  const span = npcDefaultsLiteral(source);
  return source.slice(0, span.start) + serialized + source.slice(span.end);
}

export function writeVnNpcSpritePools(source: string, pools: VnNpcSpritePools): string {
  const serialized = JSON.stringify(pools, null, 2);
  readVnNpcSpritePools(`export const npcSprites = ${serialized};`);
  if (!/\bnpcSprites\b/.test(source)) return source + `\nexport const npcSprites = ${serialized};\n`;
  readVnNpcSpritePools(source);
  const span = literalMap(source, "sprites", "npcSprites");
  return source.slice(0, span.start) + serialized + source.slice(span.end);
}

export function assignVnNpcSprite(pools: VnNpcSpritePools, gender: NpcSpriteGender, id: string, assetRef: string): VnNpcSpritePools {
  if (!id.trim() || !assetRef.trim()) throw new Error("Choose an NPC sprite image.");
  return { ...pools, [gender]: { ...pools[gender], [id]: assetRef } };
}

export function removeVnNpcSprite(pools: VnNpcSpritePools, gender: NpcSpriteGender, id: string): VnNpcSpritePools {
  const pool = { ...pools[gender] }; delete pool[id];
  return { ...pools, [gender]: pool };
}

export function writeVnAssetMap(source: string, kind: VnAssetKind, map: VnAssetMap): string {
  const span = literalMap(source, kind);
  const serialized = JSON.stringify(map, null, 2);
  // Validate the data before changing any authored source.
  literalMap(`export const ${kind === "sprites" ? "sprites" : "scenes"} = ${serialized};`, kind);
  let result = source.slice(0, span.start) + serialized + source.slice(span.end);
  if (kind === "backgrounds" && map.default && !/typeof\s+scenes\.default\s*===|\bimage\(scenes\.default\)/.test(result)) {
    // Upgrade the standard legacy fallback only, keeping custom code intact.
    const legacyLookup = /const scene = scenes\[line\?\.scene \|\| api\.variables\?\.\["current-scene"\]\];/;
    const legacyFallback = /\n([ \t]*)\|\| api\.variables\?\.\["scene-bg"\] \|\| api\.variables\?\.scene_bg \|\| api\.variables\?\.current_bg;/;
    if (!legacyLookup.test(result) || !legacyFallback.test(result)) throw invalid();
    result = result.replace(legacyFallback, '\n$1|| (typeof scenes.default === "string" ? scenes.default : scenes.default?.[api.variables?.["current-period"]] || scenes.default?.day)$&');
  }
  return result;
}

export function assignVnAsset(map: VnAssetMap, name: string, variant: string, assetRef: string, baseVariant = "normal"): VnAssetMap {
  name = name.trim(); variant = variant.trim().toLowerCase();
  if (!name || !variant || !assetRef) throw new Error("Choose a name, variant and image.");
  const key = Object.keys(map).find(key => key.toLowerCase() === name.toLowerCase()) ?? name;
  const current = map[key];
  const variants = typeof current === "string" ? { [baseVariant]: current } : current;
  return { ...map, [key]: { ...variants, [variant]: assetRef } };
}

export function removeVnAsset(map: VnAssetMap, name: string, variant: string): VnAssetMap {
  const result = { ...map };
  const current = map[name];
  if (typeof current === "string") delete result[name];
  else {
    const variants = { ...current }; delete variants[variant];
    if (Object.keys(variants).length) result[name] = variants; else delete result[name];
  }
  return result;
}

export function vnAssetRows(map: VnAssetMap, kind: VnAssetKind): VnAssetRow[] {
  return Object.entries(map).filter(([name]) => kind !== "backgrounds" || name !== "default").flatMap(([name, value]) =>
    typeof value === "string" ? [{ name, variant: kind === "sprites" ? "normal" : "day", assetRef: value }]
      : Object.entries(value).map(([variant, assetRef]) => ({ name, variant, assetRef })));
}
