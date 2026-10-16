import { normalizeSpriteExpression } from "./expressions";

/** Visual Novel → Sprites: upload character expressions or NPC pool cutouts.
 * Add character names and expressions here. Portraits stay separate. Example:
 * Miveth: { normal: "@asset:ID", happy: "@asset:ID", shy: "@asset:ID" }
 */
export const sprites = {};

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
  let map = api.variables?.["vn-sprites"] || sprites;
  try { if (typeof map === "string") map = JSON.parse(map); } catch { return null; }
  const key = Object.keys(map || {}).find(name => name.toLowerCase() === line.name.toLowerCase());
  const expressions = key ? map[key] : null;
  const emotion = normalizeSpriteExpression(line.emotion || api.variables?.[`${line.name.toLowerCase()}-emotion`]);
  const ref = typeof expressions === "string" ? expressions : expressions?.[emotion] || expressions?.normal;
  return typeof ref === "string" && ref ? { src: api.resolveAssetUrl(ref) } : npcSpriteSelection(api, line);
}

export function spriteFor(api, line) {
  return spriteDetailsFor(api, line)?.src || null;
}

/** Only read passages supply cast/expression state. Narration retains it;
 * an explicit scene change clears it. Never substitute a log portrait. */
export function sceneSprites(api, readLines, limit) {
  const cast = new Map();
  let scene = "", order = 0;
  for (const line of readLines) {
    if (line.scene && line.scene !== scene) { cast.clear(); scene = line.scene; }
    const name = line.name || line.stageName;
    if (!name) continue;
    const key = spriteKey({ ...line, name });
    const previous = cast.get(key);
    cast.set(key, { name, emotion: line.emotion, ...(line.player ? { player: true } : {}), ...(line.npcGender ? { key, npcGender: line.npcGender, npcId: line.npcId } : {}), first: previous?.first ?? order, last: order++ });
  }
  return [...cast.values()].map(character => ({ ...character, emotion: normalizeSpriteExpression(character.emotion || api.variables?.[`${character.name.toLowerCase()}-emotion`]), ...spriteDetailsFor(api, character) }))
    .filter(character => character.src).sort((a, b) => b.last - a.last).slice(0, limit)
    .sort((a, b) => a.first - b.first).map(({ name, emotion, src, key, defaultMode, player }) => ({ name, emotion, src, ...(key ? { key } : {}), ...(defaultMode ? { defaultMode } : {}), ...(player ? { player: true } : {}) }));
}
