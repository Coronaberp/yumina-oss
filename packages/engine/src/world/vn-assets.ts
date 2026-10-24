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
    ? ['sprites', 'spriteConfig', 'spriteTypes', 'spriteWardrobeDescriptions', 'spriteVariants', 'spriteVariantSprites', 'spriteVariantWardrobeDescriptions', 'spriteChapterDefaults', 'npcSprites', 'npcDefaultSpritesA', 'npcDefaultSpritesB']
    : ['scenes', 'openingScenes'];
  let result = template;
  for (const binding of bindings) {
    const declared = new RegExp(`^[ \\t]*export\\s+const\\s+${binding}\\s*=`, 'm').test(source);
    if (!declared && binding !== bindings[0]) continue;
    const depth = binding === 'spriteVariantSprites' ? 3 : ['openingScenes', 'spriteTypes', 'spriteVariantWardrobeDescriptions', 'spriteChapterDefaults'].includes(binding) ? 2 : 1;
    const saved = literalMap(source, kind, binding, depth);
    if (!declaredSpriteBinding(result, binding)) { result += `\nexport const ${binding} = ${source.slice(saved.start, saved.end)};\n`; continue; }
    const target = literalMap(result, kind, binding, depth);
    result = result.slice(0, target.start) + source.slice(saved.start, saved.end) + result.slice(target.end);
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

export type VnSpriteConfig = { types: Record<string, string>; emotions: Record<string, string> };
export type VnSpriteRow = VnAssetRow & { spriteType: string; spriteVariant?: string };
export type VnSpriteWardrobeDescriptions = Record<string, Record<string, string>>;
export type VnSpriteVariants = Record<string, Record<string, string>>;
export type VnSpriteVariantSets = Record<string, Record<string, VnAssetMap>>;
export type VnSpriteVariantWardrobeDescriptions = Record<string, Record<string, Record<string, string>>>;
export type VnSpriteOutfitSelection = { type: string; variant?: string };
export type VnSpriteChapterDefaults = Record<string, Record<string, VnSpriteOutfitSelection>>;
/** Retained for source compatibility; outfit types have no arbitrary count cap. */
export const VN_SPRITE_TYPE_LIMIT = Number.POSITIVE_INFINITY;
export const VN_SPRITE_EMOTION_WARNING = 20;
export const VN_SPRITE_EMOTION_LIMIT = 30;
export const VN_SPRITE_DEFAULT_EMOTIONS: Readonly<Record<string, string>> = Object.freeze({
  angry: "Angry", sad: "Sad", shy: "Shy", normal: "Normal", smug: "Smug", happy: "Happy",
});
const declaredSpriteBinding = (source: string, binding: string) => new RegExp(`^[ \\t]*export\\s+const\\s+${binding}\\s*=`, "m").test(source);
const spriteLabel = (id: string) => id.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
function inferredSpriteLabel(options: Record<string, string>, id: string) {
  const base=spriteLabel(id), labels=new Set(Object.values(options).map(label=>label.toLocaleLowerCase()));
  let label=base, suffix=0;
  while(labels.has(label.toLocaleLowerCase())) label=`${base} (${id}${suffix++ ? ` ${suffix}` : ""})`;
  return label;
}
const unsafeSpriteId = (id: string) => ["__proto__", "constructor", "prototype"].includes(id);
const spriteId = (label: string) => label.trim().normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
function writeSpriteLiteral(source: string, binding: string, value: unknown, depth: number): string {
  const serialized = JSON.stringify(value, null, 2);
  literalMap(`export const ${binding} = ${serialized};`, "sprites", binding, depth);
  if (!declaredSpriteBinding(source, binding)) return source + `\nexport const ${binding} = ${serialized};\n`;
  const span = literalMap(source, "sprites", binding, depth);
  return source.slice(0, span.start) + serialized + source.slice(span.end);
}

/** Clothing is authored separately from identity and image assignments. */
export function readVnSpriteWardrobeDescriptions(source: string): VnSpriteWardrobeDescriptions {
  if (!declaredSpriteBinding(source, "spriteWardrobeDescriptions")) return {};
  const raw = literalMap(source, "sprites", "spriteWardrobeDescriptions", 1).map;
  for (const [name, descriptions] of Object.entries(raw)) {
    if (!name.trim() || typeof descriptions !== "object" || descriptions === null ||
        Object.values(descriptions).some(value => typeof value !== "string")) throw invalid();
  }
  return raw as VnSpriteWardrobeDescriptions;
}

export function writeVnSpriteWardrobeDescription(source: string, name: string, type: string, description: string, spriteVariant = ""): string {
  if (!Object.hasOwn(readVnSpriteConfig(source).types, type)) throw new Error("Choose a configured wardrobe.");
  if (!name.trim() || unsafeSpriteId(name.trim()) || name.trim().length > 200 || description.length > 2000) throw new Error("Use a valid character name and an outfit description of at most 2,000 characters.");
  if (spriteVariant) {
    assertSpriteVariant(source, type, spriteVariant);
    const descriptions = readVnSpriteVariantWardrobeDescriptions(source);
    const key = characterKey(descriptions, name);
    const variants = { ...descriptions[key]?.[type] };
    if (description.trim()) variants[spriteVariant] = description.trim(); else delete variants[spriteVariant];
    const wardrobe = { ...descriptions[key] };
    if (Object.keys(variants).length) wardrobe[type] = variants; else delete wardrobe[type];
    if (Object.keys(wardrobe).length) descriptions[key] = wardrobe; else delete descriptions[key];
    return writeSpriteLiteral(source, "spriteVariantWardrobeDescriptions", descriptions, 2);
  }
  const descriptions = readVnSpriteWardrobeDescriptions(source);
  const key = Object.keys(descriptions).find(key => key.toLowerCase() === name.trim().toLowerCase()) ?? name.trim();
  const wardrobe = { ...descriptions[key] };
  if (description.trim()) wardrobe[type] = description.trim();
  else delete wardrobe[type];
  if (Object.keys(wardrobe).length) descriptions[key] = wardrobe;
  else delete descriptions[key];
  return writeSpriteLiteral(source, "spriteWardrobeDescriptions", descriptions, 1);
}

/** Data-only catalogs. Legacy custom emotions remain visible without rewriting art. */
export function readVnSpriteConfig(source: string): VnSpriteConfig {
  const raw = declaredSpriteBinding(source, "spriteConfig") ? literalMap(source, "sprites", "spriteConfig", 1).map : {};
  if (Object.keys(raw).some(key => key !== "types" && key !== "emotions")) throw invalid();
  for (const values of Object.values(raw)) {
    if (!values || typeof values !== "object" || Object.values(values).some(value => typeof value !== "string" || !value.trim())) throw invalid();
  }
  const config: VnSpriteConfig = { types: { normal: "Normal", ...(raw.types as Record<string,string> ?? {}) }, emotions: { ...VN_SPRITE_DEFAULT_EMOTIONS, ...(raw.emotions as Record<string,string> ?? {}) } };
  for (const [type, map] of Object.entries(readVnSpriteSets(source))) {
    if (!Object.hasOwn(config.types, type)) config.types[type] = inferredSpriteLabel(config.types,type);
    for (const row of vnAssetRows(map, "sprites")) if (!Object.hasOwn(config.emotions, row.variant)) config.emotions[row.variant] = inferredSpriteLabel(config.emotions,row.variant);
  }
  const variantSets = readVnSpriteVariantSets(source);
  for (const type of Object.keys(readVnSpriteVariants(source))) {
    if (!Object.hasOwn(config.types, type)) config.types[type] = inferredSpriteLabel(config.types, type);
    for (const map of Object.values(variantSets[type] ?? {})) {
      for (const row of vnAssetRows(map, "sprites")) if (!Object.hasOwn(config.emotions, row.variant)) config.emotions[row.variant] = inferredSpriteLabel(config.emotions, row.variant);
    }
  }
  return config;
}

export function readVnSpriteSets(source: string): Record<string, VnAssetMap> {
  const extra = declaredSpriteBinding(source, "spriteTypes") ? literalMap(source, "sprites", "spriteTypes", 2).map : {};
  if (Object.hasOwn(extra, "normal")) throw new Error("Normal sprites belong in the existing sprites map.");
  for (const map of Object.values(extra)) {
    if (!map || typeof map !== "object") throw invalid();
    literalMap(`export const sprites = ${JSON.stringify(map)};`, "sprites");
  }
  return { normal: readVnAssetMap(source, "sprites"), ...extra as unknown as Record<string, VnAssetMap> };
}

const characterKey = (map: Record<string, unknown>, name: string) => Object.keys(map).find(key => key.toLowerCase() === name.trim().toLowerCase()) ?? name.trim();
function assertSpriteKey(id: string): void {
  if (!id || id.length > 200 || unsafeSpriteId(id) || /[:\[\]\r\n]/.test(id)) throw new Error("Choose a valid sprite ID.");
}

/** Optional variations are independent of base outfits and may have no art. */
export function readVnSpriteVariantSets(source: string): VnSpriteVariantSets {
  const raw = declaredSpriteBinding(source, "spriteVariantSprites") ? literalMap(source, "sprites", "spriteVariantSprites", 3).map : {};
  for (const [type, variants] of Object.entries(raw)) {
    assertSpriteKey(type);
    if (!variants || typeof variants !== "object") throw invalid();
    for (const [variant, map] of Object.entries(variants)) {
      assertSpriteKey(variant);
      if (!map || typeof map !== "object") throw invalid();
      readVnAssetMap(`export const sprites = ${JSON.stringify(map)};`, "sprites");
    }
  }
  return raw as unknown as VnSpriteVariantSets;
}

export function readVnSpriteVariantWardrobeDescriptions(source: string): VnSpriteVariantWardrobeDescriptions {
  const raw = declaredSpriteBinding(source, "spriteVariantWardrobeDescriptions") ? literalMap(source, "sprites", "spriteVariantWardrobeDescriptions", 2).map : {};
  for (const [name, wardrobe] of Object.entries(raw)) {
    if (!name.trim() || !wardrobe || typeof wardrobe !== "object") throw invalid();
    for (const [type, variants] of Object.entries(wardrobe)) {
      assertSpriteKey(type);
      if (!variants || typeof variants !== "object") throw invalid();
      for (const [variant, description] of Object.entries(variants)) {
        assertSpriteKey(variant);
        if (typeof description !== "string") throw invalid();
      }
    }
  }
  return raw as unknown as VnSpriteVariantWardrobeDescriptions;
}

/** Opening IDs provide chapter presets without resetting an existing story. */
export function readVnSpriteChapterDefaults(source: string): VnSpriteChapterDefaults {
  const raw = (declaredSpriteBinding(source, "spriteChapterDefaults") ? literalMap(source, "sprites", "spriteChapterDefaults", 2).map : {}) as unknown as VnSpriteChapterDefaults;
  for (const [opening, characters] of Object.entries(raw)) {
    if (!opening.trim() || !characters || typeof characters !== "object") throw invalid();
    for (const [name, selection] of Object.entries(characters)) {
      if (!name.trim() || !selection || typeof selection !== "object" || Object.keys(selection).some(key => key !== "type" && key !== "variant")) throw invalid();
      if (typeof selection.type !== "string") throw invalid();
      assertSpriteKey(selection.type);
      if (selection.variant !== undefined && selection.variant !== "") {
        if (typeof selection.variant !== "string") throw invalid();
        assertSpriteKey(selection.variant);
      }
    }
  }
  return raw as unknown as VnSpriteChapterDefaults;
}

export function readVnSpriteVariants(source: string): VnSpriteVariants {
  const raw = declaredSpriteBinding(source, "spriteVariants") ? literalMap(source, "sprites", "spriteVariants", 1).map : {};
  const variants: VnSpriteVariants = {};
  for (const [type, options] of Object.entries(raw)) {
    assertSpriteKey(type);
    if (!options || typeof options !== "object") throw invalid();
    const labels = new Set<string>();
    for (const [id, label] of Object.entries(options)) {
      assertSpriteKey(id);
      if (typeof label !== "string" || !label.trim() || label.length > 100 || labels.has(label.trim().toLocaleLowerCase())) throw new Error("Variant names must be unique and at most 100 characters.");
      labels.add(label.trim().toLocaleLowerCase());
    }
    variants[type] = { ...options };
  }
  const infer = (type: string, id?: string) => {
    variants[type] ??= {};
    if (id && !Object.hasOwn(variants[type], id)) variants[type][id] = inferredSpriteLabel(variants[type], id);
  };
  for (const [type, sets] of Object.entries(readVnSpriteVariantSets(source))) for (const id of Object.keys(sets)) infer(type, id);
  for (const wardrobe of Object.values(readVnSpriteVariantWardrobeDescriptions(source))) for (const [type, options] of Object.entries(wardrobe)) for (const id of Object.keys(options)) infer(type, id);
  for (const wardrobe of Object.values(readVnSpriteWardrobeDescriptions(source))) for (const type of Object.keys(wardrobe)) { assertSpriteKey(type); infer(type); }
  for (const characters of Object.values(readVnSpriteChapterDefaults(source))) for (const selection of Object.values(characters)) infer(selection.type, selection.variant);
  return variants;
}

function assertSpriteVariant(source: string, type: string, variant: string): void {
  if (!Object.hasOwn(readVnSpriteVariants(source)[type] ?? {}, variant)) throw new Error("Choose a configured outfit variant.");
}

/** Available expressions and fallback are derived only from this exact outfit. */
export function readVnSpriteOutfit(source: string, name: string, type = "normal", variant = "") {
  const map = (variant ? readVnSpriteVariantSets(source)[type]?.[variant] : readVnSpriteSets(source)[type]) ?? {};
  const images = map[characterKey(map, name)];
  const expressions: Record<string, string> = Object.fromEntries(Object.entries(typeof images === "string" ? { normal: images } : images ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()));
  const descriptions = variant ? readVnSpriteVariantWardrobeDescriptions(source) : readVnSpriteWardrobeDescriptions(source);
  const wardrobe = descriptions[characterKey(descriptions, name)];
  const description = variant ? (wardrobe as VnSpriteVariantWardrobeDescriptions[string] | undefined)?.[type]?.[variant] : (wardrobe as VnSpriteWardrobeDescriptions[string] | undefined)?.[type];
  return { expressions, description: description?.trim() ?? "", defaultEmotion: Object.hasOwn(expressions, "normal") ? "normal" : Object.keys(expressions)[0] };
}

export function addVnSpriteVariant(source: string, type: string, label: string): string {
  const id = spriteId(label);
  assertSpriteKey(id);
  if (!Object.hasOwn(readVnSpriteConfig(source).types, type)) throw new Error("Choose a configured wardrobe type.");
  const variants = readVnSpriteVariants(source);
  if (Object.hasOwn(variants[type] ?? {}, id)) throw new Error("Choose a unique outfit variant name.");
  const next = { ...variants, [type]: { ...variants[type], [id]: label.trim() } };
  const result = writeSpriteLiteral(source, "spriteVariants", next, 1);
  readVnSpriteVariants(result);
  return result;
}

export function renameVnSpriteVariant(source: string, type: string, id: string, label: string): string {
  const variants = readVnSpriteVariants(source);
  if (!Object.hasOwn(variants[type] ?? {}, id)) throw new Error("Outfit variant not found.");
  variants[type]![id] = label.trim();
  const result = writeSpriteLiteral(source, "spriteVariants", variants, 1);
  readVnSpriteVariants(result);
  return result;
}

export function writeVnSpriteChapterDefault(source: string, greetingIds: readonly string[], name: string, selection?: VnSpriteOutfitSelection): string {
  if (!greetingIds.length) throw new Error("Link a chapter opening before choosing its outfit defaults.");
  if (!name.trim() || name.length > 200 || unsafeSpriteId(name.trim())) throw new Error("Choose a valid character.");
  if (selection) {
    if (!Object.hasOwn(readVnSpriteConfig(source).types, selection.type)) throw new Error("Choose a configured wardrobe type.");
    if (selection.variant) assertSpriteVariant(source, selection.type, selection.variant);
  }
  const defaults = readVnSpriteChapterDefaults(source);
  for (const opening of greetingIds) {
    if (!opening.trim() || unsafeSpriteId(opening)) throw new Error("Choose a valid opening.");
    const characters = { ...defaults[opening] }, key = characterKey(characters, name);
    if (selection) characters[key] = { type: selection.type, ...(selection.variant ? { variant: selection.variant } : {}) }; else delete characters[key];
    if (Object.keys(characters).length) defaults[opening] = characters; else delete defaults[opening];
  }
  return writeSpriteLiteral(source, "spriteChapterDefaults", defaults, 2);
}

function removeSpriteChapterSelections(source: string, predicate: (selection: VnSpriteOutfitSelection) => boolean): string {
  if (!declaredSpriteBinding(source, "spriteChapterDefaults")) return source;
  const defaults = readVnSpriteChapterDefaults(source);
  for (const [opening, characters] of Object.entries(defaults)) {
    for (const [name, selection] of Object.entries(characters)) if (predicate(selection)) delete characters[name];
    if (!Object.keys(characters).length) delete defaults[opening];
  }
  return writeSpriteLiteral(source, "spriteChapterDefaults", defaults, 2);
}

/** Detach variant assignments; underlying assets remain in the image library. */
export function removeVnSpriteVariant(source: string, type: string, id: string): string {
  const variants = readVnSpriteVariants(source);
  if (!Object.hasOwn(variants[type] ?? {}, id)) return source;
  const sets = readVnSpriteVariantSets(source);
  if (sets[type]) { delete sets[type]![id]; if (!Object.keys(sets[type]!).length) delete sets[type]; }
  const descriptions = readVnSpriteVariantWardrobeDescriptions(source);
  for (const [name, wardrobe] of Object.entries(descriptions)) {
    if (wardrobe[type]) { delete wardrobe[type]![id]; if (!Object.keys(wardrobe[type]!).length) delete wardrobe[type]; }
    if (!Object.keys(wardrobe).length) delete descriptions[name];
  }
  source = removeSpriteChapterSelections(source, selection => selection.type === type && selection.variant === id);
  if (declaredSpriteBinding(source, "spriteVariantSprites")) source = writeSpriteLiteral(source, "spriteVariantSprites", sets, 3);
  if (declaredSpriteBinding(source, "spriteVariantWardrobeDescriptions")) source = writeSpriteLiteral(source, "spriteVariantWardrobeDescriptions", descriptions, 2);
  delete variants[type]![id];
  if (!Object.keys(variants[type]!).length) delete variants[type];
  return writeSpriteLiteral(source, "spriteVariants", variants, 1);
}

export function writeVnSpriteConfig(source: string, config: VnSpriteConfig): string {
  const before = readVnSpriteConfig(source);
  if (!config || !config.types || !config.emotions) throw invalid();
  for (const kind of ["types", "emotions"] as const) {
    const limit = kind === "types" ? VN_SPRITE_TYPE_LIMIT : VN_SPRITE_EMOTION_LIMIT;
    const entries = Object.entries(config[kind]);
    if (entries.length > Math.max(limit, Object.keys(before[kind]).length)) throw new Error(`A card supports at most ${limit} ${kind}.`);
    const labels = new Set<string>();
    for (const [id,label] of entries) {
      if (!id || unsafeSpriteId(id) || /[:\[\]\r\n]/.test(id) || typeof label !== "string" || !label.trim() || label.length > 100) throw new Error("Choose a valid sprite name (1–100 characters).");
      const key=label.trim().toLocaleLowerCase();
      if (labels.has(key)) throw new Error("Sprite names must be unique.");
      labels.add(key);
    }
    const builtins = kind === "types" ? { normal: "Normal" } : VN_SPRITE_DEFAULT_EMOTIONS;
    for (const [id, label] of Object.entries(builtins)) if (config[kind][id] !== label) throw new Error("Built-in sprite options cannot be renamed or removed.");
  }
  for (const [type,map] of Object.entries(readVnSpriteSets(source))) {
    if (!Object.hasOwn(config.types,type)) throw new Error("Remove the wardrobe's images before removing its type.");
    for(const row of vnAssetRows(map,"sprites")) if(!Object.hasOwn(config.emotions,row.variant))throw new Error("Remove the emotion's images before removing its option.");
  }
  for (const row of vnSpriteRows(source)) {
    if (!Object.hasOwn(config.types, row.spriteType) || !Object.hasOwn(config.emotions, row.variant)) throw new Error("Remove the outfit's images before removing its catalog option.");
  }
  for (const type of Object.keys(readVnSpriteVariants(source))) if (!Object.hasOwn(config.types, type)) throw new Error("Remove the type's variants and clothing before removing its catalog option.");
  return writeSpriteLiteral(source, "spriteConfig", config, 1);
}

export function assignVnSprite(source: string, name: string, type: string, emotion: string, assetRef: string, spriteVariant = ""): string {
  const config = readVnSpriteConfig(source);
  if (!Object.hasOwn(config.types,type) || !Object.hasOwn(config.emotions,emotion)) throw new Error("Choose a configured wardrobe and emotion.");
  if (unsafeSpriteId(type) || unsafeSpriteId(emotion) || !name.trim() || unsafeSpriteId(name.trim()) || name.trim().length > 200 || !assetRef.trim()) throw new Error("Choose a valid character, wardrobe, emotion and image.");
  const assign = (map: VnAssetMap): VnAssetMap => {
    const key=Object.keys(map).find(key=>key.toLowerCase()===name.trim().toLowerCase())??name.trim();
    const current=map[key], variants=typeof current === "string" ? {normal:current} : current;
    return {...map,[key]:{...variants,[emotion]:assetRef}};
  };
  if (spriteVariant) {
    assertSpriteVariant(source, type, spriteVariant);
    const sets = readVnSpriteVariantSets(source);
    return writeSpriteLiteral(source, "spriteVariantSprites", { ...sets, [type]: { ...sets[type], [spriteVariant]: assign(sets[type]?.[spriteVariant] ?? {}) } }, 3);
  }
  if (type === "normal") return writeVnAssetMap(source, "sprites", assign(readVnAssetMap(source,"sprites")));
  const { normal: _normal, ...extra } = readVnSpriteSets(source);
  return writeSpriteLiteral(source,"spriteTypes",{...extra,[type]:assign(extra[type]??{})},2);
}

export function removeVnSprite(source: string, name: string, type: string, emotion: string, spriteVariant = ""): string {
  if (spriteVariant) {
    const sets = readVnSpriteVariantSets(source), map = sets[type]?.[spriteVariant];
    const key = map && Object.keys(map).find(key => key.toLowerCase() === name.trim().toLowerCase());
    if (!key) return source;
    sets[type]![spriteVariant] = removeVnAsset(map!, key, emotion);
    return writeSpriteLiteral(source, "spriteVariantSprites", sets, 3);
  }
  const sets = readVnSpriteSets(source);
  const map = sets[type];
  const key = map && Object.keys(map).find(key => key.toLowerCase() === name.trim().toLowerCase());
  if (!key) return source;
  if (type === "normal") return writeVnAssetMap(source,"sprites",removeVnAsset(sets.normal!,key,emotion));
  const {normal:_normal,...extra}=sets;
  if (!extra[type]) return source;
  extra[type]=removeVnAsset(extra[type],key,emotion);
  return writeSpriteLiteral(source,"spriteTypes",extra,2);
}

export function vnSpriteRows(source: string): VnSpriteRow[] {
  return [
    ...Object.entries(readVnSpriteSets(source)).flatMap(([spriteType,map])=>vnAssetRows(map,"sprites").map(row=>({...row,spriteType}))),
    ...Object.entries(readVnSpriteVariantSets(source)).flatMap(([spriteType, variants]) => Object.entries(variants).flatMap(([spriteVariant, map]) => vnAssetRows(map, "sprites").map(row => ({ ...row, spriteType, spriteVariant })))),
  ];
}

/** Recompute from the current draft; no separate catalog cache or agent refresh. */
export function readVnSpriteInventory(source: string, entries: ReadonlyArray<Pick<WorldEntry, "name" | "role" | "tags">> = []) {
  const sets = readVnSpriteSets(source);
  const wardrobeDescriptions = readVnSpriteWardrobeDescriptions(source);
  const variants = readVnSpriteVariants(source), variantSets = readVnSpriteVariantSets(source);
  const variantWardrobeDescriptions = readVnSpriteVariantWardrobeDescriptions(source), chapterDefaults = readVnSpriteChapterDefaults(source);
  const names = [
    ...vnCharacterNames(entries), ...Object.values(sets).flatMap(map => Object.keys(map)), ...Object.keys(wardrobeDescriptions),
    ...Object.values(variantSets).flatMap(variations => Object.values(variations).flatMap(map => Object.keys(map))),
    ...Object.keys(variantWardrobeDescriptions), ...Object.values(chapterDefaults).flatMap(map => Object.keys(map)),
  ];
  const characters = new Map<string, string>();
  for (const name of names) if (name.trim() && !characters.has(name.toLowerCase())) characters.set(name.toLowerCase(), name);
  return { config: readVnSpriteConfig(source), rows: vnSpriteRows(source), characters: [...characters.values()], wardrobeDescriptions, variants, variantSets, variantWardrobeDescriptions, chapterDefaults };
}

export function addVnSpriteOption(source: string, kind: keyof VnSpriteConfig, label: string): string {
  const config=readVnSpriteConfig(source);
  const id=spriteId(label);
  if (!id || Object.hasOwn(config[kind],id)) throw new Error("Choose a unique sprite name.");
  return writeVnSpriteConfig(source,{...config,[kind]:{...config[kind],[id]:label.trim()}});
}

export function renameVnSpriteOption(source: string, kind: keyof VnSpriteConfig, id: string, label: string): string {
  const config=readVnSpriteConfig(source);
  if (!Object.hasOwn(config[kind],id)) throw new Error("Sprite option not found.");
  return writeVnSpriteConfig(source,{...config,[kind]:{...config[kind],[id]:label.trim()}});
}

/** Removing a custom option removes only its image assignments; assets stay in the library. */
export function removeVnSpriteOption(source: string, kind: keyof VnSpriteConfig, id: string): string {
  const config=readVnSpriteConfig(source);
  if (id === "normal" || (kind === "emotions" && Object.hasOwn(VN_SPRITE_DEFAULT_EMOTIONS,id))) throw new Error("Built-in sprite options cannot be removed.");
  if (!Object.hasOwn(config[kind],id)) return source;
  if (kind === "types") {
    for (const variant of Object.keys(readVnSpriteVariants(source)[id] ?? {})) source = removeVnSpriteVariant(source, id, variant);
    source = removeSpriteChapterSelections(source, selection => selection.type === id);
    const {normal:_normal,...extra}=readVnSpriteSets(source); delete extra[id];
    source=writeSpriteLiteral(source,"spriteTypes",extra,2);
    if (declaredSpriteBinding(source, "spriteWardrobeDescriptions")) {
      const descriptions = readVnSpriteWardrobeDescriptions(source);
      for (const [name, wardrobe] of Object.entries(descriptions)) {
        delete wardrobe[id];
        if (!Object.keys(wardrobe).length) delete descriptions[name];
      }
      source = writeSpriteLiteral(source, "spriteWardrobeDescriptions", descriptions, 1);
    }
    if (declaredSpriteBinding(source, "spriteVariants")) {
      const variants = readVnSpriteVariants(source); delete variants[id];
      source = writeSpriteLiteral(source, "spriteVariants", variants, 1);
    }
  } else {
    for(const row of vnSpriteRows(source).filter(row=>row.variant===id))source=removeVnSprite(source,row.name,row.spriteType,row.variant,row.spriteVariant);
  }
  const values={...config[kind]};delete values[id];
  return writeVnSpriteConfig(source,{...config,[kind]:values});
}

/** Save-boundary guard: unchanged custom/legacy files are left alone. */
export function assertVnSpriteCatalogUpdate(beforeSource: string | undefined, afterSource: string | undefined): void {
  if (!afterSource || beforeSource === afterSource) return;
  readVnSpriteWardrobeDescriptions(afterSource);
  readVnSpriteVariants(afterSource);
  readVnSpriteChapterDefaults(afterSource);
  let next: VnSpriteConfig;
  try { next=readVnSpriteConfig(afterSource); }
  catch (error) { if (["spriteConfig", "spriteTypes", "spriteVariants", "spriteVariantSprites", "spriteVariantWardrobeDescriptions", "spriteChapterDefaults"].some(binding => declaredSpriteBinding(afterSource, binding))) throw error; return; }
  let previous: VnSpriteConfig | undefined;
  if (beforeSource) { try { previous=readVnSpriteConfig(beforeSource); } catch { /* A custom old map is not evaluated. */ } }
  for(const kind of ["types","emotions"] as const){
    const limit=kind === "types" ? VN_SPRITE_TYPE_LIMIT : VN_SPRITE_EMOTION_LIMIT;
    if(Object.keys(next[kind]).length>Math.max(limit,Object.keys(previous?.[kind]??{}).length))throw new Error(`A card supports at most ${limit} ${kind}.`);
  }
  writeVnSpriteConfig(afterSource,next);
}
