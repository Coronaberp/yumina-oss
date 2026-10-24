// Generated guarded feature edits from the immutable pre-variant runtime.
export const spriteVariantRuntimePatches: Array<{file:string; declaration:string; before:string; after:string; append?:boolean; data?:boolean}> = [
  {
    "file": "sprites.ts",
    "declaration": "import:./expressions",
    "before": "import { normalizeSpriteExpression, normalizeSpriteId } from \"./expressions\";",
    "after": "import { normalizeSpriteExpression, normalizeSpriteId, normalizeSpriteSelectionId } from \"./expressions\";"
  },
  {
    "file": "sprites.ts",
    "declaration": "import:./passages",
    "before": "",
    "after": "import { messagePassages } from \"./passages\";",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteVariants",
    "before": "",
    "after": "export const spriteVariants = {};",
    "append": true,
    "data": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteVariantSprites",
    "before": "",
    "after": "export const spriteVariantSprites = {};",
    "append": true,
    "data": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteVariantWardrobeDescriptions",
    "before": "",
    "after": "export const spriteVariantWardrobeDescriptions = {};",
    "append": true,
    "data": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteChapterDefaults",
    "before": "",
    "after": "export const spriteChapterDefaults = {};",
    "append": true,
    "data": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteObjectFor",
    "before": "",
    "after": "function spriteObjectFor(api, key, fallback) {\n  let value = api.variables?.[key] ?? fallback;\n  try { if (typeof value === \"string\") value = JSON.parse(value); } catch { return {}; }\n  return value && typeof value === \"object\" && !Array.isArray(value) ? value : {};\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteVariantSetsFor",
    "before": "",
    "after": "export function spriteVariantSetsFor(api) {\n  return spriteObjectFor(api, \"vn-sprite-variant-sprites\", spriteVariantSprites);\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteVariantCatalogFor",
    "before": "",
    "after": "export function spriteVariantCatalogFor(api) {\n  const declared = spriteObjectFor(api, \"vn-sprite-variants\", spriteVariants);\n  const catalog = Object.fromEntries(Object.entries(declared).map(([type, variants]) => [type, { ...variants }]));\n  const inventories = spriteVariantSetsFor(api);\n  const descriptions = spriteObjectFor(api, \"vn-sprite-variant-wardrobe-descriptions\", spriteVariantWardrobeDescriptions);\n  const include = (type, variant) => {\n    if (typeof type !== \"string\" || !type.trim()) return;\n    if (!Object.hasOwn(catalog, type)) Object.defineProperty(catalog, type, { value: {}, enumerable: true });\n    if (typeof variant !== \"string\" || !variant || Object.hasOwn(catalog[type], variant)) return;\n    const base = variant.replace(/[-_]+/g, \" \").replace(/\\b\\w/g, char => char.toUpperCase());\n    const labels = new Set(Object.values(catalog[type]).filter(label => typeof label === \"string\").map(label => label.toLocaleLowerCase()));\n    let label = base, suffix = 0;\n    while (labels.has(label.toLocaleLowerCase())) label = `${base} (${variant}${suffix++ ? ` ${suffix}` : \"\"})`;\n    Object.defineProperty(catalog[type], variant, { value: label, enumerable: true });\n  };\n  for (const [type, variants] of Object.entries(inventories)) for (const variant of Object.keys(variants || {})) include(type, variant);\n  for (const outfits of Object.values(descriptions)) for (const [type, variants] of Object.entries(outfits || {})) for (const variant of Object.keys(variants || {})) include(type, variant);\n  for (const outfits of Object.values(spriteObjectFor(api, \"vn-sprite-wardrobe-descriptions\", spriteWardrobeDescriptions))) for (const type of Object.keys(outfits || {})) include(type);\n  for (const characters of Object.values(spriteObjectFor(api, \"vn-sprite-chapter-defaults\", spriteChapterDefaults))) for (const selection of Object.values(characters || {})) include(selection?.type, selection?.variant);\n  return catalog;\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteCatalogFor",
    "before": "      }\n    }\n  }\n  return catalog;\n}",
    "after": "      }\n    }\n  }\n  for (const type of Object.keys(spriteVariantCatalogFor(api))) infer(catalog.types, type);\n  for (const variants of Object.values(spriteVariantSetsFor(api))) for (const map of Object.values(variants || {})) {\n    for (const expressions of Object.values(map || {})) if (expressions && typeof expressions === \"object\") {\n      for (const emotion of Object.keys(expressions)) infer(catalog.emotions, emotion);\n    }\n  }\n  return catalog;\n}"
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteOutfitFor",
    "before": "",
    "after": "export function spriteOutfitFor(api, name, type = \"normal\", variant = \"\") {\n  const inventories = spriteSetsFor(api), variants = spriteVariantSetsFor(api);\n  const pool = characterExpressions(variant ? variants[type]?.[variant] : inventories[type], name);\n  const expressions = Object.fromEntries(Object.entries(typeof pool === \"string\" ? { normal: pool } : pool || {})\n    .filter(([, ref]) => typeof ref === \"string\" && ref.trim()));\n  const normal = Object.keys(expressions).find(emotion => normalizeSpriteId(emotion) === \"normal\");\n  const defaultEmotion = normal || Object.keys(expressions)[0];\n  const descriptions = variant\n    ? spriteObjectFor(api, \"vn-sprite-variant-wardrobe-descriptions\", spriteVariantWardrobeDescriptions)\n    : spriteObjectFor(api, \"vn-sprite-wardrobe-descriptions\", spriteWardrobeDescriptions);\n  const character = Object.keys(descriptions).find(key => key.toLowerCase() === name.toLowerCase());\n  const value = character ? variant ? descriptions[character]?.[type]?.[variant] : descriptions[character]?.[type] : \"\";\n  return { expressions, defaultEmotion, description: typeof value === \"string\" ? value.trim() : \"\" };\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteSelectionFor",
    "before": "",
    "after": "function spriteSelectionFor(api, rawType, rawVariant) {\n  if (typeof rawType !== \"string\" || !rawType.trim()) return;\n  const types = spriteCatalogFor(api).types, id = normalizeSpriteSelectionId(rawType);\n  if (!id || (rawVariant != null && typeof rawVariant !== \"string\")) return;\n  const type = Object.keys(types).find(key => normalizeSpriteId(key) === id);\n  if (!type) return;\n  const variantId = typeof rawVariant === \"string\" && rawVariant.trim() ? normalizeSpriteSelectionId(rawVariant) : \"\";\n  if (variantId === undefined) return;\n  const variants = spriteVariantCatalogFor(api)[type] || {};\n  const variant = variantId ? Object.keys(variants).find(key => normalizeSpriteId(key) === variantId) : \"\";\n  if (variant === undefined) return;\n  return { type, variant };\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteOpeningFor",
    "before": "",
    "after": "function spriteOpeningFor(api, message) {\n  // Restored swipe state is newer evidence than read-time hydration kept on\n  // the same message object. A greeting switch can change the opening itself.\n  const restoredOpening = message?.stateSnapshot?.activeGreetingId;\n  if (typeof restoredOpening === \"string\" || restoredOpening === null) return restoredOpening;\n  const hydratedOpening = message?.spriteWardrobeSnapshot?.openingId;\n  if (typeof hydratedOpening === \"string\" || hydratedOpening === null) return hydratedOpening;\n  const all = api.messages || [], boundary = message ? all.findIndex(row => row.id === message.id) : all.length - 1;\n  const messages = boundary >= 0 ? all.slice(0, boundary + 1) : [];\n  for (let index = messages.length - 1; index >= 0; index--) {\n    const id = messages[index].stateSnapshot?.activeGreetingId;\n    if (messages[index].role === \"assistant\" && (typeof id === \"string\" || id === null)) return id;\n  }\n  if (!api.hasEarlierMessages) {\n    const greetings = (api.entries || []).filter(entry => entry.role === \"greeting\" && entry.enabled !== false)\n      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));\n    const opening = messages.find(row => row.role === \"assistant\");\n    return greetings[opening?.activeSwipeIndex || 0]?.id;\n  }\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteWardrobesFor",
    "before": "",
    "after": "export function spriteWardrobesFor(api, message, readLines = []) {\n  const openingId = spriteOpeningFor(api, message), selected = new Map();\n  const defaults = spriteObjectFor(api, \"vn-sprite-chapter-defaults\", spriteChapterDefaults)[openingId] || {};\n  const reset = () => {\n    selected.clear();\n    for (const [name, value] of Object.entries(defaults)) {\n      const selection = spriteSelectionFor(api, value?.type, value?.variant);\n      if (selection) selected.set(name.toLowerCase(), selection);\n    }\n  };\n  const accept = line => {\n    const name = line.name || line.stageName;\n    if (!name || line.player || /^(npc|narrator|narration)$/i.test(name)) return;\n    const selection = spriteSelectionFor(api, line.spriteType, line.spriteVariant);\n    if (selection) selected.set(name.toLowerCase(), selection);\n  };\n  reset();\n  const messages = api.messages || [], boundary = message ? messages.findIndex(row => row.id === message.id) : messages.length;\n  const previous = boundary >= 0 ? messages.slice(0, boundary) : [];\n  let start = 0;\n  for (let index = previous.length - 1; index >= 0; index--) {\n    const id = previous[index].stateSnapshot?.activeGreetingId;\n    if (previous[index].role === \"assistant\" && (typeof id === \"string\" || id === null) && id !== openingId) { start = index + 1; break; }\n  }\n  const seed = row => {\n    // Hydration is reconstructed from the active accepted branch on every\n    // history read. Stored snapshots may belong to an older earlier swipe.\n    const candidates = [row?.spriteWardrobeSnapshot, row?.stateSnapshot?.metadata?.vnSpriteWardrobes];\n    const saved = candidates.find(value => value?.version === 1 && value.openingId === (openingId ?? null) && value.before && typeof value.before === \"object\" && !Array.isArray(value.before));\n    if (!saved) return;\n    for (const [name, value] of Object.entries(saved.before)) {\n      const selection = spriteSelectionFor(api, value?.type, value?.variant);\n      if (selection) selected.set(name.toLowerCase(), selection);\n    }\n  };\n  const accepted = previous.slice(start).filter(row => row.role === \"assistant\" && ![\"failed\", \"generating\", \"streaming\"].includes(row.status));\n  // Exactly one missing-history anchor; later cached outcomes must never\n  // override an earlier reply's newly selected active swipe.\n  seed(accepted[0] || message);\n  for (const row of accepted) {\n    if ((row.content || \"\").includes(\"[CHARACTER_CREATE]\")) reset();\n    for (const line of messagePassages(api, row)) accept(line);\n  }\n  if ((message?.content || \"\").includes(\"[CHARACTER_CREATE]\")) reset();\n  readLines.forEach(accept);\n  return Object.fromEntries(selected);\n}",
    "append": true
  },
  {
    "file": "sprites.ts",
    "declaration": "spriteDetailsFor",
    "before": "    const fallback = playerNpcSpriteSelection(api, line);\n    return fallback ? { ...fallback, player: true } : null;\n  }\n  const sets = spriteSetsFor(api);\n  const requestedType = normalizeSpriteId(line.spriteType);\n  const type = Object.hasOwn(sets, requestedType) ? requestedType : Object.keys(sets).find(key => normalizeSpriteId(key) === requestedType) || requestedType;\n  const requested = characterExpressions(sets[type], line.name), normal = characterExpressions(sets.normal, line.name);\n  const configured = { ...spriteCatalogFor(api).emotions, ...(typeof normal === \"object\" ? normal : {}), ...(typeof requested === \"object\" ? requested : {}) };\n  const emotion = normalizeSpriteExpression(line.emotion || api.variables?.[`${line.name.toLowerCase()}-emotion`], configured);\n  const ref = spriteReference(requested, emotion) || spriteReference(requested, \"normal\") || spriteReference(normal, emotion) || spriteReference(normal, \"normal\");\n  return ref ? { src: api.resolveAssetUrl(ref), emotion, spriteType: type } : npcSpriteSelection(api, line);\n}",
    "after": "    const fallback = playerNpcSpriteSelection(api, line);\n    return fallback ? { ...fallback, player: true } : null;\n  }\n  if (line.name === \"NPC\") return npcSpriteSelection(api, line);\n  const selection = spriteSelectionFor(api, line.spriteType, line.spriteVariant)\n    || spriteWardrobesFor(api)[line.name.toLowerCase()] || { type: \"normal\", variant: \"\" };\n  const outfit = spriteOutfitFor(api, line.name, selection.type, selection.variant);\n  const requestedEmotion = normalizeSpriteExpression(line.emotion || api.variables?.[`${line.name.toLowerCase()}-emotion`], outfit.expressions);\n  const emotion = Object.hasOwn(outfit.expressions, requestedEmotion) ? requestedEmotion : outfit.defaultEmotion;\n  const ref = emotion ? spriteReference(outfit.expressions, emotion) : null;\n  return ref ? { src: api.resolveAssetUrl(ref), emotion, spriteType: selection.type, ...(selection.variant ? { spriteVariant: selection.variant } : {}) } : null;\n}"
  },
  {
    "file": "sprites.ts",
    "declaration": "sceneSprites",
    "before": "export function sceneSprites(api, readLines, limit) {\n  const cast = new Map();\n  let scene = \"\", order = 0;\n  for (const line of readLines) {\n    if (line.scene && line.scene !== scene) { cast.clear(); scene = line.scene; }",
    "after": "export function sceneSprites(api, readLines, limit, message) {\n  const cast = new Map();\n  // Legacy callers without a reading cursor must not inspect later replies.\n  const wardrobes = spriteWardrobesFor(message ? api : { ...api, messages: [] }, message);\n  let scene = \"\", order = 0;\n  for (const line of readLines) {\n    if (line.scene && line.scene !== scene) { cast.clear(); scene = line.scene; }"
  },
  {
    "file": "sprites.ts",
    "declaration": "sceneSprites",
    "before": "    cast.set(key, { name, emotion: line.emotion, spriteType: line.spriteType, ...(line.player ? { player: true } : {}), ...(line.npcGender ? { key, npcGender: line.npcGender, npcId: line.npcId } : {}), first: previous?.first ?? order, last: order++ });",
    "after": "    const selection = !line.player && name !== \"NPC\" ? spriteSelectionFor(api, line.spriteType, line.spriteVariant) : null;\n    if (selection) Object.defineProperty(wardrobes, name.toLowerCase(), { value: selection, configurable: true, enumerable: true, writable: true });\n    const outfit = wardrobes[name.toLowerCase()] || { type: \"normal\", variant: \"\" };\n    cast.set(key, { name, emotion: line.emotion, spriteType: outfit.type, spriteVariant: outfit.variant, ...(line.player ? { player: true } : {}), ...(line.npcGender ? { key, npcGender: line.npcGender, npcId: line.npcId } : {}), first: previous?.first ?? order, last: order++ });"
  },
  {
    "file": "sprites.ts",
    "declaration": "sceneSprites",
    "before": ".map(({ name, emotion, spriteType, src, key, defaultMode, player }) => ({ name, emotion, ...(spriteType ? { spriteType } : {}), src, ...(key ? { key } : {}), ...(defaultMode ? { defaultMode } : {}), ...(player ? { player: true } : {}) }));",
    "after": ".map(({ name, emotion, spriteType, spriteVariant, src, key, defaultMode, player }) => ({ name, emotion, ...(spriteType ? { spriteType } : {}), ...(spriteVariant ? { spriteVariant } : {}), src, ...(key ? { key } : {}), ...(defaultMode ? { defaultMode } : {}), ...(player ? { player: true } : {}) }));"
  },
  {
    "file": "passages.ts",
    "declaration": "import:./expressions",
    "before": "import { normalizeSpriteId } from \"./expressions\";",
    "after": "import { normalizeSpriteId, normalizeSpriteSelectionId } from \"./expressions\";"
  },
  {
    "file": "passages.ts",
    "declaration": "passages",
    "before": "  const initialFields = leading?.[2]?.split(\":\").map(field => field.trim()) || [];\n  let name = legacy.speaker || leading?.[1]?.trim() || \"\", emotion = normalizeSpriteId(initialFields[0]), scene = \"\", offset = 0, explicit = !!leading,\n    npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(initialFields[1] || \"\") ? initialFields[1].toLowerCase() : \"\";\n  let spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" ? normalizeSpriteId(initialFields[1]) : \"normal\";\n  let npcId = npcGender ? initialFields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n  const chunks = [];\n  const literals = dialogueSpans(content).filter(span => span.kind === \"literal\" || span.kind === \"dialogue\");",
    "after": "  const initialFields = leading?.[2]?.split(\":\").map(field => field.trim()) || [];\n  let name = legacy.speaker || leading?.[1]?.trim() || \"\", emotion = normalizeSpriteId(initialFields[0]), scene = \"\", offset = 0, explicit = !!leading,\n    npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(initialFields[1] || \"\") ? initialFields[1].toLowerCase() : \"\";\n  let spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" && initialFields[1] ? normalizeSpriteId(initialFields[1]) : undefined;\n  let spriteVariant = spriteType && initialFields[2] ? normalizeSpriteId(initialFields[2]) : undefined;\n  let npcId = npcGender ? initialFields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n  const chunks = [];\n  const literals = dialogueSpans(content).filter(span => span.kind === \"literal\" || span.kind === \"dialogue\");"
  },
  {
    "file": "passages.ts",
    "declaration": "passages",
    "before": "    if (isPresentationLiteral(protectedRanges, match.index)) continue;\n    if (literals.some(span => match.index >= span.end - span.text.length && match.index < span.end)) continue;\n    if (opaque.some(span => match.index >= span.index && match.index < span.index + span[0].length)) continue;\n    chunks.push({ text: content.slice(offset, match.index), name, emotion, spriteType, scene, explicit, npcGender, npcId });\n    if (match[4]) scene = match[4].trim();\n    else {\n      name = match[2].trim();\n      const fields = match[3].split(\":\").map(field => field.trim());\n      emotion = normalizeSpriteId(fields[0]); explicit = true;\n      spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" ? normalizeSpriteId(fields[1]) : \"normal\";\n      npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(fields[1] || \"\") ? fields[1].toLowerCase() : \"\";\n      npcId = npcGender ? fields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n    }\n    offset = match.index + match[0].length;\n  }\n  chunks.push({ text: content.slice(offset), name, emotion, spriteType, scene, explicit, npcGender, npcId });\n  const playerSpeaker = name => /^(?:\\{\\{user\\}\\}|you|user|player)$/i.test(name || \"\") || !!player?.name && String(name).toLocaleLowerCase() === player.name.toLocaleLowerCase() && !character(entries, name);\n  return chunks.flatMap(chunk => {\n    const declared = character(entries, chunk.name);",
    "after": "    if (isPresentationLiteral(protectedRanges, match.index)) continue;\n    if (literals.some(span => match.index >= span.end - span.text.length && match.index < span.end)) continue;\n    if (opaque.some(span => match.index >= span.index && match.index < span.index + span[0].length)) continue;\n    chunks.push({ text: content.slice(offset, match.index), name, emotion, spriteType, spriteVariant, scene, explicit, npcGender, npcId });\n    if (match[4]) scene = match[4].trim();\n    else {\n      name = match[2].trim();\n      const fields = match[3].split(\":\").map(field => field.trim());\n      emotion = normalizeSpriteId(fields[0]); explicit = true;\n      spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" && fields[1] ? normalizeSpriteId(fields[1]) : undefined;\n      spriteVariant = spriteType && fields[2] ? normalizeSpriteId(fields[2]) : undefined;\n      npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(fields[1] || \"\") ? fields[1].toLowerCase() : \"\";\n      npcId = npcGender ? fields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n    }\n    offset = match.index + match[0].length;\n  }\n  chunks.push({ text: content.slice(offset), name, emotion, spriteType, spriteVariant, scene, explicit, npcGender, npcId });\n  const playerSpeaker = name => /^(?:\\{\\{user\\}\\}|you|user|player)$/i.test(name || \"\") || !!player?.name && String(name).toLocaleLowerCase() === player.name.toLocaleLowerCase() && !character(entries, name);\n  return chunks.flatMap(chunk => {\n    const declared = character(entries, chunk.name);"
  },
  {
    "file": "passages.ts",
    "declaration": "passages",
    "before": "        return pages(text).map(text => ({ name: isPlayer ? player?.name ? `${player.name} (You)` : \"You\" : spoken ? definedSpeaker ? displayCharacterName(definedSpeaker.name) : \"NPC\" : \"\", portrait: isPlayer ? player?.avatar || null : definedSpeaker?.portrait || null,\n          ...(isPlayer ? { player: true } : {}),\n          ...(!spoken && declared && chunk.explicit && span.kind !== \"literal\" ? { stageName: displayCharacterName(declared.name) } : {}),\n          emotion: chunk.emotion, spriteType: chunk.spriteType, scene: chunk.scene, kind, text,\n          ...(spoken && !definedSpeaker && chunk.npcGender ? { npcGender: chunk.npcGender, npcId: chunk.npcId } : {}) }));\n      });\n    });",
    "after": "        return pages(text).map(text => ({ name: isPlayer ? player?.name ? `${player.name} (You)` : \"You\" : spoken ? definedSpeaker ? displayCharacterName(definedSpeaker.name) : \"NPC\" : \"\", portrait: isPlayer ? player?.avatar || null : definedSpeaker?.portrait || null,\n          ...(isPlayer ? { player: true } : {}),\n          ...(!spoken && declared && chunk.explicit && span.kind !== \"literal\" ? { stageName: displayCharacterName(declared.name) } : {}),\n          emotion: chunk.emotion, spriteType: chunk.spriteType, spriteVariant: chunk.spriteVariant, scene: chunk.scene, kind, text,\n          ...(spoken && !definedSpeaker && chunk.npcGender ? { npcGender: chunk.npcGender, npcId: chunk.npcId } : {}) }));\n      });\n    });"
  },
  {
    "file": "passages.ts",
    "declaration": "segmentPassages",
    "before": "      const gender = typeof segment.gender === \"string\" && /^(male|female)$/i.test(segment.gender.trim()) ? segment.gender.trim().toLowerCase() : \"\";\n      const id = typeof segment.npcId === \"string\" ? segment.npcId.replace(/[\\]\\r\\n]/g, \"\").trim() : \"unknown\";\n      const metadata = !entry && name === \"NPC\" && gender ? `:${gender}:${id || \"unknown\"}` : \"\";\n      const spriteType = name !== \"NPC\" && name !== \"Narrator\" ? `:${normalizeSpriteId(segment.spriteType)}` : \"\";\n      const markup = `[SPEAKER:${name}:${normalizeSpriteId(segment.emotion)}${metadata || spriteType}] ${segment.text}`;\n      return passages(api.entries, markup, markup, api.user);\n    });",
    "after": "      const gender = typeof segment.gender === \"string\" && /^(male|female)$/i.test(segment.gender.trim()) ? segment.gender.trim().toLowerCase() : \"\";\n      const id = typeof segment.npcId === \"string\" ? segment.npcId.replace(/[\\]\\r\\n]/g, \"\").trim() : \"unknown\";\n      const metadata = !entry && name === \"NPC\" && gender ? `:${gender}:${id || \"unknown\"}` : \"\";\n      const typeId = normalizeSpriteSelectionId(segment.spriteType);\n      const variantId = segment.spriteVariant == null || segment.spriteVariant === \"\" ? \"\" : normalizeSpriteSelectionId(segment.spriteVariant);\n      const spriteType = name !== \"NPC\" && name !== \"Narrator\" && typeId && variantId !== undefined\n        ? `:${typeId}${variantId ? `:${variantId}` : \"\"}` : \"\";\n      const markup = `[SPEAKER:${name}:${normalizeSpriteId(segment.emotion)}${metadata || spriteType}] ${segment.text}`;\n      return passages(api.entries, markup, markup, api.user);\n    });"
  },
  {
    "file": "expressions.ts",
    "declaration": "normalizeSpriteSelectionId",
    "before": "",
    "after": "export function normalizeSpriteSelectionId(value: unknown): string | undefined {\n  if (typeof value !== \"string\" || [\"__proto__\", \"constructor\", \"prototype\"].includes(value.trim().toLowerCase())) return;\n  const key = typeof value === \"string\" ? value.trim().normalize(\"NFKC\").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \"-\").replace(/^-+|-+$/g, \"\") : \"\";\n  return key && !/[:|\\]\\r\\n]/.test(key) && ![\"constructor\", \"prototype\"].includes(key) ? key : undefined;\n}",
    "append": true
  },
  {
    "file": "expressions.ts",
    "declaration": "normalizeSpriteId",
    "before": "export function normalizeSpriteId(value: unknown): string {\n  const key = typeof value === \"string\" ? value.trim().normalize(\"NFKC\").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \"-\").replace(/^-+|-+$/g, \"\") : \"\";\n  return key && !/[:|\\]\\r\\n]/.test(key) && ![\"__proto__\", \"constructor\", \"prototype\"].includes(key) ? key : \"normal\";\n}",
    "after": "export function normalizeSpriteId(value: unknown): string {\n  return normalizeSpriteSelectionId(value) || \"normal\";\n}"
  },
  {
    "file": "presentation-markup.ts",
    "declaration": "import:./expressions",
    "before": "import { normalizeSpriteId as expression } from \"./expressions\";",
    "after": "import { normalizeSpriteId as expression, normalizeSpriteSelectionId } from \"./expressions\";"
  },
  {
    "file": "presentation-markup.ts",
    "declaration": "standardizeSpeakerMarkup",
    "before": "    if (!name || /[:\\]\\r\\n]/.test(name)) return source;\n    const emotion = /(?:^|\\s)(?:emotion|expression)\\s*=\\s*[\"']([^\"'\\r\\n]+)[\"']/i.exec(attrs)?.[1];\n    const spriteType = /(?:^|\\s)(?:spriteType|sprite-type|type)\\s*=\\s*[\"\\']([^\"\\'\\r\\n]+)[\"\\']/i.exec(attrs)?.[1];\n    const content = body.trim();\n    const speech = tag.toLowerCase() === \"dialogue\" && !/^[\"'“‘«「『]/.test(content) ? `“${content}”` : content;\n    return `[SPEAKER:${name}:${expression(emotion)}${spriteType ? `:${expression(spriteType)}` : \"\"}]\\n${speech}`;\n  });\n  literals = presentationLiteralRanges(text);\n  text = text.replace(/<(narration|action)\\s*>([\\s\\S]*?)<\\/\\1\\s*>/gi, (source, _tag: string, body: string, index: number) => {",
    "after": "    if (!name || /[:\\]\\r\\n]/.test(name)) return source;\n    const emotion = /(?:^|\\s)(?:emotion|expression)\\s*=\\s*[\"']([^\"'\\r\\n]+)[\"']/i.exec(attrs)?.[1];\n    const spriteType = /(?:^|\\s)(?:spriteType|sprite-type|type)\\s*=\\s*[\"\\']([^\"\\'\\r\\n]+)[\"\\']/i.exec(attrs)?.[1];\n    const spriteVariant = /(?:^|\\s)(?:spriteVariant|sprite-variant)\\s*=\\s*[\"']([^\"'\\r\\n]+)[\"']/i.exec(attrs)?.[1];\n    const typeId = normalizeSpriteSelectionId(spriteType), variantId = spriteVariant ? normalizeSpriteSelectionId(spriteVariant) : \"\";\n    const wardrobe = typeId && (!spriteVariant || variantId) ? `:${typeId}${variantId ? `:${variantId}` : \"\"}` : \"\";\n    const content = body.trim();\n    const speech = tag.toLowerCase() === \"dialogue\" && !/^[\"'“‘«「『]/.test(content) ? `“${content}”` : content;\n    return `[SPEAKER:${name}:${expression(emotion)}${wardrobe}]\\n${speech}`;\n  });\n  literals = presentationLiteralRanges(text);\n  text = text.replace(/<(narration|action)\\s*>([\\s\\S]*?)<\\/\\1\\s*>/gi, (source, _tag: string, body: string, index: number) => {"
  },
  {
    "file": "presentation-markup.ts",
    "declaration": "standardizeSpeakerMarkup",
    "before": "    const emotion = name === \"Narrator\" ? \"normal\" : expression(fields[0]);\n    const gender = name === \"NPC\" && /^(male|female)$/i.test(fields[1] || \"\") ? fields[1]!.toLowerCase() : \"\";\n    const id = gender ? fields.slice(2).join(\":\").trim() : \"\";\n    const spriteType = name !== \"Narrator\" && name !== \"NPC\" && fields[1] ? expression(fields[1]) : \"\";\n    return `[SPEAKER:${name}:${emotion}${spriteType ? `:${spriteType}` : \"\"}${gender ? `:${gender}${id ? `:${id}` : \"\"}` : \"\"}]`;\n  });\n}",
    "after": "    const emotion = name === \"Narrator\" ? \"normal\" : expression(fields[0]);\n    const gender = name === \"NPC\" && /^(male|female)$/i.test(fields[1] || \"\") ? fields[1]!.toLowerCase() : \"\";\n    const id = gender ? fields.slice(2).join(\":\").trim() : \"\";\n    const spriteType = name !== \"Narrator\" && name !== \"NPC\" && fields[1] ? normalizeSpriteSelectionId(fields[1]) : \"\";\n    const spriteVariant = spriteType && fields[2] ? normalizeSpriteSelectionId(fields[2]) : \"\";\n    const wardrobe = spriteType && (!fields[2] || spriteVariant) ? `:${spriteType}${spriteVariant ? `:${spriteVariant}` : \"\"}` : \"\";\n    return `[SPEAKER:${name}:${emotion}${wardrobe}${gender ? `:${gender}${id ? `:${id}` : \"\"}` : \"\"}]`;\n  });\n}"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "import:./sprites",
    "before": "import { spriteSetsFor, spriteCatalogFor } from \"./sprites\";",
    "after": "import { spriteOutfitFor, spriteCatalogFor, spriteVariantCatalogFor } from \"./sprites\";"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "expressionSprites",
    "before": "export function expressionSprites(api, target) {\n  const sets = spriteSetsFor(api), config = spriteCatalogFor(api);\n  const images = Object.entries({ ...config.types, ...Object.fromEntries(Object.keys(sets).map(type => [type, config.types[type] || type])) }).flatMap(([spriteType, typeLabel]) => {\n    const map = sets[spriteType];\n    const key = Object.keys(map || {}).find(name => name.toLowerCase() === target.name.toLowerCase());\n    const pool = key ? map[key] : null;\n    if (typeof pool === \"string\" && pool) return [{ expression: \"normal\", label: config.emotions.normal, spriteType, typeLabel, src: api.resolveAssetUrl(pool) }];\n    const emotions = [...new Set([...Object.keys(config.emotions), ...Object.keys(pool || {})])];\n    return emotions.flatMap(expression => typeof pool?.[expression] === \"string\" && pool[expression] ? [{ expression, label: config.emotions[expression] || expression, spriteType, typeLabel, src: api.resolveAssetUrl(pool[expression]) }] : []);\n  });\n  return images.length ? images : target.portrait ? [{ expression: \"portrait\", label: \"Portrait\", spriteType: \"normal\", typeLabel: \"Normal\", src: api.resolveAssetUrl(target.portrait) }] : [];\n}",
    "after": "export function expressionSprites(api, target) {\n  const config = spriteCatalogFor(api), variants = spriteVariantCatalogFor(api);\n  return Object.entries(config.types).flatMap(([spriteType, typeLabel]) => {\n    const outfits = [[\"\", \"Base outfit\"], ...Object.entries(variants[spriteType] || {})];\n    return outfits.flatMap(([spriteVariant, variantLabel]) => {\n      const outfit = spriteOutfitFor(api, target.name, spriteType, spriteVariant);\n      return Object.entries(outfit.expressions).map(([expression, ref]) => ({ expression, label: config.emotions[expression] || expression,\n        spriteType, typeLabel, spriteVariant, variantLabel, src: api.resolveAssetUrl(ref) }));\n    });\n  });\n}"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "useCharacterViewer",
    "before": "spriteTypes: spriteCatalogFor(live.current).types,",
    "after": "spriteTypes: spriteCatalogFor(live.current).types, spriteVariants: spriteVariantCatalogFor(live.current),"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "useCharacterViewer",
    "before": "spriteTypes: spriteCatalogFor(api).types } : null",
    "after": "spriteTypes: spriteCatalogFor(api).types, spriteVariants: spriteVariantCatalogFor(api) } : null"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "CharacterViewer",
    "before": "export function CharacterViewer({ controller, preview = false }) {\n  const { viewer, close, retry } = controller;\n  const [spriteType, setSpriteType] = React.useState(\"normal\"), [expression, setExpression] = React.useState(0), [imageFailed, setImageFailed] = React.useState(false);\n  const dialog = React.useRef(null);\n  React.useLayoutEffect(() => { if (!preview) dialog.current.querySelector('[aria-label=\"Close character viewer\"]').focus({ preventScroll: true }); }, [preview]);\n  React.useEffect(() => {",
    "after": "export function CharacterViewer({ controller, preview = false }) {\n  const { viewer, close, retry } = controller;\n  const [spriteType, setSpriteType] = React.useState(\"normal\"), [spriteVariant, setSpriteVariant] = React.useState(\"\"), [expression, setExpression] = React.useState(0), [imageFailed, setImageFailed] = React.useState(false);\n  const dialog = React.useRef(null);\n  React.useLayoutEffect(() => { if (!preview) dialog.current.querySelector('[aria-label=\"Close character viewer\"]').focus({ preventScroll: true }); }, [preview]);\n  React.useEffect(() => {"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "CharacterViewer",
    "before": "    return () => window.removeEventListener(\"keydown\", keydown, true);\n  });\n  const types = Object.entries(viewer.spriteTypes || Object.fromEntries(viewer.images.map(image => [image.spriteType, image.typeLabel])));\n  const images = viewer.images.filter(image => image.spriteType === spriteType);\n  const image = images[expression] || images[0];\n  const stats = viewer.stats.filter(stat => !stat.relationship), relationships = viewer.stats.filter(stat => stat.relationship);\n  return <section className=\"vn-overlay vn-character-overlay\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Character viewer\" ref={dialog}>",
    "after": "    return () => window.removeEventListener(\"keydown\", keydown, true);\n  });\n  const types = Object.entries(viewer.spriteTypes || Object.fromEntries(viewer.images.map(image => [image.spriteType, image.typeLabel])));\n  const variants = [[\"\", \"Base outfit\"], ...Object.entries(viewer.spriteVariants?.[spriteType] || {})];\n  const images = viewer.images.filter(image => image.spriteType === spriteType && (image.spriteVariant || \"\") === spriteVariant);\n  const image = images[expression] || images[0];\n  const stats = viewer.stats.filter(stat => !stat.relationship), relationships = viewer.stats.filter(stat => stat.relationship);\n  return <section className=\"vn-overlay vn-character-overlay\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Character viewer\" ref={dialog}>"
  },
  {
    "file": "character-viewer.tsx",
    "declaration": "CharacterViewer",
    "before": "      <div className=\"vn-character-body\">\n        <div className=\"vn-character-art\">\n          <div className=\"vn-character-sprite\">{image && !imageFailed ? <img src={image.src} alt={`${viewer.target.label} — ${image.expression}`} onError={() => setImageFailed(true)} /> : <span>{imageFailed ? \"Sprite could not be loaded.\" : \"No sprite uploaded.\"}</span>}</div>\n          {types.length > 1 && <div className=\"vn-character-expressions\" role=\"group\" aria-label=\"Sprite types\">{types.map(([type, label]) => <button key={type} aria-pressed={spriteType === type} onClick={() => { setSpriteType(type); setExpression(0); setImageFailed(false); }}>{label}</button>)}</div>}\n          {images.length > 1 && <div className=\"vn-character-expressions\" role=\"group\" aria-label=\"Sprite expressions\">{images.map((image, index) => <button key={image.expression} aria-label={`View ${image.expression} sprite`} aria-pressed={expression === index} onClick={() => { setExpression(index); setImageFailed(false); }}>{image.label || image.expression}</button>)}</div>}\n        </div>\n        <div className=\"vn-character-details\">",
    "after": "      <div className=\"vn-character-body\">\n        <div className=\"vn-character-art\">\n          <div className=\"vn-character-sprite\">{image && !imageFailed ? <img src={image.src} alt={`${viewer.target.label} — ${image.expression}`} onError={() => setImageFailed(true)} /> : <span>{imageFailed ? \"Sprite could not be loaded.\" : \"No sprite uploaded.\"}</span>}</div>\n          {types.length > 1 && <div className=\"vn-character-expressions\" role=\"group\" aria-label=\"Sprite types\">{types.map(([type, label]) => <button key={type} aria-pressed={spriteType === type} onClick={() => { setSpriteType(type); setSpriteVariant(\"\"); setExpression(0); setImageFailed(false); }}>{label}</button>)}</div>}\n          {variants.length > 1 && <div className=\"vn-character-expressions\" role=\"group\" aria-label=\"Outfit variants\">{variants.map(([variant, label]) => <button key={variant || \"base\"} aria-pressed={spriteVariant === variant} onClick={() => { setSpriteVariant(variant); setExpression(0); setImageFailed(false); }}>{label}</button>)}</div>}\n          {images.length > 1 && <div className=\"vn-character-expressions\" role=\"group\" aria-label=\"Sprite expressions\">{images.map((image, index) => <button key={image.expression} aria-label={`View ${image.expression} sprite`} aria-pressed={expression === index} onClick={() => { setExpression(index); setImageFailed(false); }}>{image.label || image.expression}</button>)}</div>}\n        </div>\n        <div className=\"vn-character-details\">"
  },
  {
    "file": "index.tsx",
    "declaration": "VN",
    "before": "sceneSprites(sceneApi, spriteLines, spriteLimit)",
    "after": "sceneSprites(sceneApi, spriteLines, spriteLimit, currentMessage)"
  }
];
