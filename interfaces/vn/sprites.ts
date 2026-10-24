import { normalizeSpriteExpression, normalizeSpriteId, normalizeSpriteSelectionId } from "./expressions";
import { messagePassages } from "./passages";

/** Visual Novel → Sprites: upload character expressions or NPC pool cutouts.
 * Add character names and expressions here. Portraits stay separate. Example:
 * Miveth: { normal: "@asset:ID", happy: "@asset:ID", shy: "@asset:ID" }
 */
export const sprites = {};

/** Card-wide labels. Additional types and emotions are authored per card. */
export const spriteConfig = { types: { normal: "Normal", uniform: "Uniform", casual: "Casual", "controlled-battle": "Controlled_Battle", "battle-holder": "Battle_Holder", "battle-cascade": "Battle_Cascade" }, emotions: { angry: "Angry", sad: "Sad", shy: "Shy", normal: "Normal", smug: "Smug", happy: "Happy" } };
/** Additional wardrobes: { typeId: { Character: { emotion: "@asset:ID" } } }. */
export const spriteTypes = {};

/** Character wardrobe descriptions: { Character: { typeId: "Clothing description" } }. */
export const spriteWardrobeDescriptions = {};

/** Optional variants inside each type: { typeId: { variantId: "Label" } }. */
export const spriteVariants = {};
/** Variant art: { typeId: { variantId: { Character: { emotion: "@asset:ID" } } } }. */
export const spriteVariantSprites = {};
/** Variant clothing: { Character: { typeId: { variantId: "Clothing description" } } }. */
export const spriteVariantWardrobeDescriptions = {};
/** Opening/chapter defaults: { greetingEntryId: { Character: { type: "typeId", variant: "variantId" } } }. */
export const spriteChapterDefaults = {};

function spriteObjectFor(api, key, fallback) {
  let value = api.variables?.[key] ?? fallback;
  try { if (typeof value === "string") value = JSON.parse(value); } catch { return {}; }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function spriteVariantSetsFor(api) {
  return spriteObjectFor(api, "vn-sprite-variant-sprites", spriteVariantSprites);
}

export function spriteVariantCatalogFor(api) {
  const declared = spriteObjectFor(api, "vn-sprite-variants", spriteVariants);
  const catalog = Object.fromEntries(Object.entries(declared).map(([type, variants]) => [type, { ...variants }]));
  const inventories = spriteVariantSetsFor(api);
  const descriptions = spriteObjectFor(api, "vn-sprite-variant-wardrobe-descriptions", spriteVariantWardrobeDescriptions);
  const include = (type, variant) => {
    if (typeof type !== "string" || !type.trim()) return;
    if (!Object.hasOwn(catalog, type)) Object.defineProperty(catalog, type, { value: {}, enumerable: true });
    if (typeof variant !== "string" || !variant || Object.hasOwn(catalog[type], variant)) return;
    const base = variant.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    const labels = new Set(Object.values(catalog[type]).filter(label => typeof label === "string").map(label => label.toLocaleLowerCase()));
    let label = base, suffix = 0;
    while (labels.has(label.toLocaleLowerCase())) label = `${base} (${variant}${suffix++ ? ` ${suffix}` : ""})`;
    Object.defineProperty(catalog[type], variant, { value: label, enumerable: true });
  };
  for (const [type, variants] of Object.entries(inventories)) for (const variant of Object.keys(variants || {})) include(type, variant);
  for (const outfits of Object.values(descriptions)) for (const [type, variants] of Object.entries(outfits || {})) for (const variant of Object.keys(variants || {})) include(type, variant);
  for (const outfits of Object.values(spriteObjectFor(api, "vn-sprite-wardrobe-descriptions", spriteWardrobeDescriptions))) for (const type of Object.keys(outfits || {})) include(type);
  for (const characters of Object.values(spriteObjectFor(api, "vn-sprite-chapter-defaults", spriteChapterDefaults))) for (const selection of Object.values(characters || {})) include(selection?.type, selection?.variant);
  return catalog;
}

export function spriteSetsFor(api) {
  let normal = api.variables?.["vn-sprites"] || sprites;
  let types = api.variables?.["vn-sprite-types"] || spriteTypes;
  try { if (typeof normal === "string") normal = JSON.parse(normal); } catch { normal = {}; }
  try { if (typeof types === "string") types = JSON.parse(types); } catch { types = {}; }
  return { ...(types && typeof types === "object" && !Array.isArray(types) ? types : {}), normal };
}

export function spriteCatalogFor(api) {
  let config = api.variables?.["vn-sprite-config"] || spriteConfig;
  try { if (typeof config === "string") config = JSON.parse(config); } catch { config = spriteConfig; }
  const catalog = { types: { normal: "Normal", ...config?.types }, emotions: { ...spriteConfig.emotions, ...config?.emotions } };
  const infer = (options, id) => {
    if (Object.hasOwn(options, id)) return;
    const base = id.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    const labels = new Set(Object.values(options).filter(label => typeof label === "string").map(label => label.toLocaleLowerCase()));
    let label = base, suffix = 0;
    while (labels.has(label.toLocaleLowerCase())) label = `${base} (${id}${suffix++ ? ` ${suffix}` : ""})`;
    Object.defineProperty(options, id, { value: label, enumerable: true, configurable: true, writable: true });
  };
  const inventories = spriteSetsFor(api);
  for (const type of ["normal", ...Object.keys(inventories).filter(type => type !== "normal")]) {
    infer(catalog.types, type);
    const map = inventories[type];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const expressions of Object.values(map)) {
      if (typeof expressions === "string") infer(catalog.emotions, "normal");
      else if (expressions && typeof expressions === "object" && !Array.isArray(expressions)) {
        for (const emotion of Object.keys(expressions)) infer(catalog.emotions, emotion);
      }
    }
  }
  for (const type of Object.keys(spriteVariantCatalogFor(api))) infer(catalog.types, type);
  for (const variants of Object.values(spriteVariantSetsFor(api))) for (const map of Object.values(variants || {})) {
    for (const expressions of Object.values(map || {})) if (expressions && typeof expressions === "object") {
      for (const emotion of Object.keys(expressions)) infer(catalog.emotions, emotion);
    }
  }
  return catalog;
}

function characterExpressions(map, name) {
  const key = Object.keys(map || {}).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? map[key] : null;
}

function spriteReference(expressions, emotion) {
  const key = expressions && typeof expressions === "object"
    ? Object.keys(expressions).find(key => normalizeSpriteId(key) === normalizeSpriteId(emotion)) : null;
  const ref = typeof expressions === "string" ? expressions : expressions?.[emotion] || (key ? expressions[key] : null);
  return typeof ref === "string" && ref.trim() ? ref : null;
}

/** Art and clothing are scoped to this exact outfit; an empty outfit stays empty. */
export function spriteOutfitFor(api, name, type = "normal", variant = "") {
  const inventories = spriteSetsFor(api), variants = spriteVariantSetsFor(api);
  const pool = characterExpressions(variant ? variants[type]?.[variant] : inventories[type], name);
  const expressions = Object.fromEntries(Object.entries(typeof pool === "string" ? { normal: pool } : pool || {})
    .filter(([, ref]) => typeof ref === "string" && ref.trim()));
  const normal = Object.keys(expressions).find(emotion => normalizeSpriteId(emotion) === "normal");
  const defaultEmotion = normal || Object.keys(expressions)[0];
  const descriptions = variant
    ? spriteObjectFor(api, "vn-sprite-variant-wardrobe-descriptions", spriteVariantWardrobeDescriptions)
    : spriteObjectFor(api, "vn-sprite-wardrobe-descriptions", spriteWardrobeDescriptions);
  const character = Object.keys(descriptions).find(key => key.toLowerCase() === name.toLowerCase());
  const value = character ? variant ? descriptions[character]?.[type]?.[variant] : descriptions[character]?.[type] : "";
  return { expressions, defaultEmotion, description: typeof value === "string" ? value.trim() : "" };
}

function spriteSelectionFor(api, rawType, rawVariant) {
  if (typeof rawType !== "string" || !rawType.trim()) return;
  const types = spriteCatalogFor(api).types, id = normalizeSpriteSelectionId(rawType);
  if (!id || (rawVariant != null && typeof rawVariant !== "string")) return;
  const type = Object.keys(types).find(key => normalizeSpriteId(key) === id);
  if (!type) return;
  const variantId = typeof rawVariant === "string" && rawVariant.trim() ? normalizeSpriteSelectionId(rawVariant) : "";
  if (variantId === undefined) return;
  const variants = spriteVariantCatalogFor(api)[type] || {};
  const variant = variantId ? Object.keys(variants).find(key => normalizeSpriteId(key) === variantId) : "";
  if (variant === undefined) return;
  return { type, variant };
}

/** Opening detection follows background selection, bounded to the viewed reply. */
function spriteOpeningFor(api, message) {
  // Restored swipe state is newer evidence than read-time hydration kept on
  // the same message object. A greeting switch can change the opening itself.
  const restoredOpening = message?.stateSnapshot?.activeGreetingId;
  if (typeof restoredOpening === "string" || restoredOpening === null) return restoredOpening;
  const hydratedOpening = message?.spriteWardrobeSnapshot?.openingId;
  if (typeof hydratedOpening === "string" || hydratedOpening === null) return hydratedOpening;
  const all = api.messages || [], boundary = message ? all.findIndex(row => row.id === message.id) : all.length - 1;
  const messages = boundary >= 0 ? all.slice(0, boundary + 1) : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const id = messages[index].stateSnapshot?.activeGreetingId;
    if (messages[index].role === "assistant" && (typeof id === "string" || id === null)) return id;
  }
  if (!api.hasEarlierMessages) {
    const greetings = (api.entries || []).filter(entry => entry.role === "greeting" && entry.enabled !== false)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
    const opening = messages.find(row => row.role === "assistant");
    return greetings[opening?.activeSwipeIndex || 0]?.id;
  }
}

/** Replay accepted earlier replies and only the currently revealed passages. */
export function spriteWardrobesFor(api, message, readLines = []) {
  const openingId = spriteOpeningFor(api, message), selected = new Map();
  const defaults = spriteObjectFor(api, "vn-sprite-chapter-defaults", spriteChapterDefaults)[openingId] || {};
  const reset = () => {
    selected.clear();
    for (const [name, value] of Object.entries(defaults)) {
      const selection = spriteSelectionFor(api, value?.type, value?.variant);
      if (selection) selected.set(name.toLowerCase(), selection);
    }
  };
  const accept = line => {
    const name = line.name || line.stageName;
    if (!name || line.player || /^(npc|narrator|narration)$/i.test(name)) return;
    const selection = spriteSelectionFor(api, line.spriteType, line.spriteVariant);
    if (selection) selected.set(name.toLowerCase(), selection);
  };
  reset();
  const messages = api.messages || [], boundary = message ? messages.findIndex(row => row.id === message.id) : messages.length;
  const previous = boundary >= 0 ? messages.slice(0, boundary) : [];
  let start = 0;
  for (let index = previous.length - 1; index >= 0; index--) {
    const id = previous[index].stateSnapshot?.activeGreetingId;
    if (previous[index].role === "assistant" && (typeof id === "string" || id === null) && id !== openingId) { start = index + 1; break; }
  }
  const seed = row => {
    // Hydration is reconstructed from the active accepted branch on every
    // history read. Stored snapshots may belong to an older earlier swipe.
    const candidates = [row?.spriteWardrobeSnapshot, row?.stateSnapshot?.metadata?.vnSpriteWardrobes];
    const saved = candidates.find(value => value?.version === 1 && value.openingId === (openingId ?? null) && value.before && typeof value.before === "object" && !Array.isArray(value.before));
    if (!saved) return;
    for (const [name, value] of Object.entries(saved.before)) {
      const selection = spriteSelectionFor(api, value?.type, value?.variant);
      if (selection) selected.set(name.toLowerCase(), selection);
    }
  };
  const accepted = previous.slice(start).filter(row => row.role === "assistant" && !["failed", "generating", "streaming"].includes(row.status));
  // Exactly one missing-history anchor; later cached outcomes must never
  // override an earlier reply's newly selected active swipe.
  seed(accepted[0] || message);
  for (const row of accepted) {
    if ((row.content || "").includes("[CHARACTER_CREATE]")) reset();
    for (const line of messagePassages(api, row)) accept(line);
  }
  if ((message?.content || "").includes("[CHARACTER_CREATE]")) reset();
  readLines.forEach(accept);
  return Object.fromEntries(selected);
}

/** Uploaded cutouts take precedence over the selected defaults for their gender. */
export const npcSprites = { "male": {}, "female": {} };
export const npcDefaults = { "disabled": false, "mode": "a" };
export const npcDefaultSpritesA = {
  "male": { "figure": "/vn-assets/npc/default-a/male-dark.png" },
  "female": { "figure": "/vn-assets/npc/default-a/female-dark.png" }
};

/** Default B: the original thigh-up NPC set, with stable selection IDs. */
export const npcDefaultSpritesB = {
  "male": {
    "male_01-7e32b59aed94": "/vn-assets/npc/male/male_01.png",
    "male_02-bb759eed4252": "/vn-assets/npc/male/male_02.png",
    "male_03-7cdb0fe89af1": "/vn-assets/npc/male/male_03.png",
    "male_04-a43c5d87bbac": "/vn-assets/npc/male/male_04.png",
    "male_05-30157662492c": "/vn-assets/npc/male/male_05.png",
    "male_06-3cfd1a929751": "/vn-assets/npc/male/male_06.png",
    "male_07-64babb351f4b": "/vn-assets/npc/male/male_07.png",
    "male_08-5cae11119fc8": "/vn-assets/npc/male/male_08.png",
    "male_09-c4c1ac38338c": "/vn-assets/npc/male/male_09.png",
    "male_10-6cefc3fb0b86": "/vn-assets/npc/male/male_10.png",
    "male_11-20107dd0aa09": "/vn-assets/npc/male/male_11.png",
    "male_12-c33b02a47c48": "/vn-assets/npc/male/male_12.png",
    "male_13-33738b872637": "/vn-assets/npc/male/male_13.png",
    "male_14-b7173ed21f13": "/vn-assets/npc/male/male_14.png",
    "male_15-2f0738458966": "/vn-assets/npc/male/male_15.png"
  },
  "female": {
    "female_01-28d37b342178": "/vn-assets/npc/female/female_01.png",
    "female_02-220c08dea779": "/vn-assets/npc/female/female_02.png",
    "female_03-cda88d78c500": "/vn-assets/npc/female/female_03.png",
    "female_04-e99c311249df": "/vn-assets/npc/female/female_04.png",
    "female_05-0fefc8cc38df": "/vn-assets/npc/female/female_05.png",
    "female_06-58670eda1f99": "/vn-assets/npc/female/female_06.png",
    "female_07-fed4cf81c883": "/vn-assets/npc/female/female_07.png",
    "female_08-5f3237aad9ae": "/vn-assets/npc/female/female_08.png",
    "female_09-022709022459": "/vn-assets/npc/female/female_09.png",
    "female_10-5d08c8a728e7": "/vn-assets/npc/female/female_10.png",
    "female_11-1a20e5559f83": "/vn-assets/npc/female/female_11.png",
    "female_12-c4fa1011bf70": "/vn-assets/npc/female/female_12.png",
    "female_13-6880c704af4e": "/vn-assets/npc/female/female_13.png",
    "female_14-af10430280b3": "/vn-assets/npc/female/female_14.png",
    "female_15-bb22d32dd3fb": "/vn-assets/npc/female/female_15.png"
  }
};

export function spriteKey(line) {
  if (line?.player) return "player";
  return line?.name === "NPC" && line.npcGender
    ? `npc:${line.npcGender}:${line.npcId || "unknown"}` : line?.name?.toLowerCase() || "";
}

/** A session-seeded random assignment is repeatable on reload and replay.
 * Image order, render count and expression changes never reroll an NPC. */
export function npcSpriteSelection(api, line) {
  const gender = line?.npcGender;
  if (line?.name !== "NPC" || (gender !== "male" && gender !== "female")) return null;
  const override = api.variables?.["vn-npc-sprites"];
  let pools = override ?? npcSprites;
  try { if (typeof pools === "string") pools = JSON.parse(pools); } catch { return null; }
  let pool = pools?.[gender] ?? (override == null ? {} : null);
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return null;
  let defaultMode;
  if (!Object.values(pool).some(ref => typeof ref === "string" && ref.trim()) && override == null) {
    if (npcDefaults.disabled || !["a", "b"].includes(npcDefaults.mode)) return null;
    defaultMode = npcDefaults.mode;
    pool = (defaultMode === "a" ? npcDefaultSpritesA : npcDefaultSpritesB)[gender];
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) return null;
  }
  const seed = `${api.sessionId || api.worldId || "vn"}:${spriteKey(line)}`;
  let selected = null, highest = -1;
  for (const [id, ref] of Object.entries(pool)) {
    if (typeof ref !== "string" || !ref.trim()) continue;
    let score = 2166136261;
    for (const char of `${seed}:${id}`) score = Math.imul(score ^ char.codePointAt(0), 16777619) >>> 0;
    if (score > highest || (score === highest && id < selected.id)) { highest = score; selected = { id, ref }; }
  }
  return selected ? { src: api.resolveAssetUrl(selected.ref), ...(defaultMode ? { defaultMode } : {}) } : null;
}

export function npcSpriteFor(api, line) {
  return npcSpriteSelection(api, line)?.src || null;
}

/** Player personas without uploaded cutouts still get a stable stage sprite.
 * This uses the existing NPC pool/default assets without inferring a gender. */
function playerNpcSpriteSelection(api, line) {
  const override = api.variables?.["vn-npc-sprites"];
  let pools = override ?? npcSprites;
  try { if (typeof pools === "string") pools = JSON.parse(pools); } catch { pools = null; }
  const custom = [];
  for (const gender of ["male", "female"]) {
    const pool = pools?.[gender];
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
    for (const [id, ref] of Object.entries(pool)) if (typeof ref === "string" && ref.trim()) custom.push([`${gender}:${id}`, ref]);
  }
  let entries = custom, defaultMode;
  if (!entries.length) {
    defaultMode = ["a", "b"].includes(npcDefaults.mode) ? npcDefaults.mode : "a";
    const defaults = defaultMode === "b" ? npcDefaultSpritesB : npcDefaultSpritesA;
    entries = ["male", "female"].flatMap(gender => Object.entries(defaults[gender] || {}).map(([id, ref]) => [`${gender}:${id}`, ref]));
  }
  const seed = `${api.sessionId || api.worldId || "vn"}:${spriteKey(line)}`;
  let selected = null, highest = -1;
  for (const [id, ref] of entries) {
    let score = 2166136261;
    for (const char of `${seed}:${id}`) score = Math.imul(score ^ char.codePointAt(0), 16777619) >>> 0;
    if (score > highest || (score === highest && id < selected.id)) { highest = score; selected = { id, ref }; }
  }
  return selected ? { src: api.resolveAssetUrl(selected.ref), ...(defaultMode ? { defaultMode } : {}) } : null;
}

function spriteDetailsFor(api, line) {
  if (!line?.name) return null;
  if (line.player) {
    const expressions = api.user?.sprites;
    const emotion = normalizeSpriteExpression(line.emotion);
    const ref = expressions?.[emotion] || expressions?.normal;
    if (typeof ref === "string" && ref.trim()) return { src: api.resolveAssetUrl(ref), player: true };
    const fallback = playerNpcSpriteSelection(api, line);
    return fallback ? { ...fallback, player: true } : null;
  }
  if (line.name === "NPC") return npcSpriteSelection(api, line);
  const selection = spriteSelectionFor(api, line.spriteType, line.spriteVariant)
    || spriteWardrobesFor(api)[line.name.toLowerCase()] || { type: "normal", variant: "" };
  const outfit = spriteOutfitFor(api, line.name, selection.type, selection.variant);
  const requestedEmotion = normalizeSpriteExpression(line.emotion || api.variables?.[`${line.name.toLowerCase()}-emotion`], outfit.expressions);
  const emotion = Object.hasOwn(outfit.expressions, requestedEmotion) ? requestedEmotion : outfit.defaultEmotion;
  const ref = emotion ? spriteReference(outfit.expressions, emotion) : null;
  return ref ? { src: api.resolveAssetUrl(ref), emotion, spriteType: selection.type, ...(selection.variant ? { spriteVariant: selection.variant } : {}) } : null;
}

export function spriteFor(api, line) {
  return spriteDetailsFor(api, line)?.src || null;
}

/** Only read passages supply cast/expression state. Narration retains it;
 * an explicit scene change clears it. Never substitute a log portrait. */
export function sceneSprites(api, readLines, limit, message) {
  const cast = new Map();
  // Legacy callers without a reading cursor must not inspect later replies.
  const wardrobes = spriteWardrobesFor(message ? api : { ...api, messages: [] }, message);
  let scene = "", order = 0;
  for (const line of readLines) {
    if (line.scene && line.scene !== scene) { cast.clear(); scene = line.scene; }
    const name = line.name || line.stageName;
    if (!name) continue;
    const key = spriteKey({ ...line, name });
    const previous = cast.get(key);
    const selection = !line.player && name !== "NPC" ? spriteSelectionFor(api, line.spriteType, line.spriteVariant) : null;
    if (selection) Object.defineProperty(wardrobes, name.toLowerCase(), { value: selection, configurable: true, enumerable: true, writable: true });
    const outfit = wardrobes[name.toLowerCase()] || { type: "normal", variant: "" };
    cast.set(key, { name, emotion: line.emotion, spriteType: outfit.type, spriteVariant: outfit.variant, ...(line.player ? { player: true } : {}), ...(line.npcGender ? { key, npcGender: line.npcGender, npcId: line.npcId } : {}), first: previous?.first ?? order, last: order++ });
  }
  return [...cast.values()].map(character => ({ ...character, emotion: normalizeSpriteExpression(character.emotion || api.variables?.[`${character.name.toLowerCase()}-emotion`]), ...spriteDetailsFor(api, character) }))
    .filter(character => character.src).sort((a, b) => b.last - a.last).slice(0, limit)
    .sort((a, b) => a.first - b.first).map(({ name, emotion, spriteType, spriteVariant, src, key, defaultMode, player }) => ({ name, emotion, ...(spriteType ? { spriteType } : {}), ...(spriteVariant ? { spriteVariant } : {}), src, ...(key ? { key } : {}), ...(defaultMode ? { defaultMode } : {}), ...(player ? { player: true } : {}) }));
}
