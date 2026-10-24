import {
  VN_ASSET_ORDER_FILE, VN_BACKGROUND_TEMPLATE, VN_SPRITE_EMOTION_WARNING, VN_SPRITE_EMOTION_LIMIT, assignVnAsset, assignVnNpcSprite,
  isVnInterface, readVnAssetMap, readVnAssetOrders,
  readVnNpcDefaults, readVnNpcSpritePools, readVnOpeningScenes, removeVnAsset,
  removeVnNpcSprite, vnAssetFile, vnAssetRowId, vnAssetRows, writeVnAssetMap,
  writeVnNpcDefaults, writeVnNpcSpritePools, writeVnOpeningScenes,
  addVnSpriteVariant, renameVnSpriteVariant, removeVnSpriteVariant, readVnSpriteOutfit, writeVnSpriteChapterDefault,
  readVnSpriteConfig, readVnSpriteInventory, writeVnSpriteWardrobeDescription, vnSpriteRows, assignVnSprite, removeVnSprite,
  addVnSpriteOption, renameVnSpriteOption, removeVnSpriteOption,
  type WorldDefinition, type VnAssetRow,
} from "@yumina/engine";
import { z } from "zod";

const scopeSchema = z.object({
  kind: z.enum(["sprites", "backgrounds"]),
  openingId: z.string().min(1).max(200).optional(),
  npcGender: z.enum(["male", "female"]).optional(),
  spriteType: z.string().trim().min(1).max(100).optional(),
  spriteVariant: z.string().trim().max(100).optional(),
}).superRefine((value, context) => {
  if (value.spriteVariant !== undefined && (value.kind !== "sprites" || value.npcGender || !value.spriteType)) context.addIssue({ code: "custom", message: "Outfit variants require a character spriteType." });
  if (value.spriteType && (value.kind !== "sprites" || value.npcGender)) context.addIssue({ code: "custom", message: "Wardrobe types apply only to character sprites." });
  if (value.kind === "sprites" && value.openingId) context.addIssue({ code: "custom", message: "Sprites are shared across openings." });
  if (value.kind === "backgrounds" && value.npcGender) context.addIssue({ code: "custom", message: "NPC gender applies to sprites only." });
});

const editSchema = z.object({
  kind: z.enum(["sprites", "backgrounds"]),
  action: z.enum(["assign", "remove", "set_default", "clear_default", "reorder", "configure_npc_defaults", "add_option", "rename_option", "remove_option", "set_wardrobe_description", "add_variant", "rename_variant", "remove_variant", "set_chapter_outfit", "clear_chapter_outfit"]),
  openingId: z.string().min(1).max(200).optional(),
  npcGender: z.enum(["male", "female"]).optional(),
  spriteType: z.string().trim().min(1).max(100).optional(),
  spriteVariant: z.string().trim().max(100).optional(),
  chapterOpeningId: z.string().min(1).max(200).optional(),
  optionKind: z.enum(["types", "emotions"]).optional(),
  optionId: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  variant: z.string().trim().min(1).max(100).optional(),
  assetRef: z.string().regex(/^@asset:[A-Za-z0-9_-]+$/, "Use an owned image's @asset reference from list_assets or import_danbooru_image.").optional(),
  order: z.array(z.string().max(500)).min(1).max(2000).optional(),
  disabled: z.boolean().optional(),
  mode: z.enum(["a", "b"]).optional(),
}).strict();

export function parseVnAssetOperation(input: unknown) {
  const operation = editSchema.parse(input);
  scopeSchema.parse(operation);
  if (["add_variant", "rename_variant", "remove_variant"].includes(operation.action)) {
    if (operation.kind !== "sprites" || operation.npcGender || operation.openingId || !operation.spriteType) throw new Error("Variant catalog actions require a character spriteType.");
    if (operation.action !== "add_variant" && !operation.spriteVariant) throw new Error("Provide a configured spriteVariant ID.");
    if (operation.action !== "remove_variant" && !operation.label) throw new Error("Provide the variant label.");
  }
  if (["set_chapter_outfit", "clear_chapter_outfit"].includes(operation.action)) {
    if (operation.kind !== "sprites" || operation.npcGender || operation.openingId || !operation.chapterOpeningId || !operation.name) throw new Error("Provide a character name and chapterOpeningId for the chapter outfit.");
    if (operation.action === "set_chapter_outfit" && !operation.spriteType) throw new Error("Provide the chapter spriteType.");
  } else if (operation.chapterOpeningId) throw new Error("chapterOpeningId applies only to chapter outfit actions.");
  if (operation.action === "set_wardrobe_description") {
    if (operation.kind !== "sprites" || operation.npcGender || operation.openingId) throw new Error("Wardrobe descriptions apply only to shared character sprites.");
    if (!operation.name || !operation.spriteType || operation.description === undefined) throw new Error("Provide a character name, configured spriteType, and description; an empty description removes it.");
  }
  if (["add_option", "rename_option", "remove_option"].includes(operation.action)) {
    if (operation.kind !== "sprites" || operation.npcGender || operation.openingId || operation.spriteType || operation.spriteVariant !== undefined) throw new Error("Catalog options apply to the card-wide character sprite catalog only.");
    if (!operation.optionKind) throw new Error("Choose optionKind types or emotions.");
    if (operation.action !== "add_option" && !operation.optionId) throw new Error("Provide an optionId from list_vn_assets.");
    if (operation.action !== "remove_option" && !operation.label) throw new Error("Provide the option label.");
  }
  if ((operation.action === "assign" || operation.action === "remove") && !operation.name) throw new Error("A character, scene, or NPC sprite name is required.");
  if ((operation.action === "assign" || operation.action === "set_default") && !operation.assetRef) throw new Error("An image assetRef is required.");
  if ((operation.action === "set_default" || operation.action === "clear_default") && operation.kind !== "backgrounds") throw new Error("Default backgrounds apply to backgrounds only.");
  if (operation.action === "configure_npc_defaults" && (operation.kind !== "sprites" || (operation.disabled === undefined && operation.mode === undefined))) throw new Error("Provide a sprite default mode or disabled flag.");
  if (operation.action === "reorder" && (!operation.order || new Set(operation.order).size !== operation.order.length)) throw new Error("Provide unique row IDs from list_vn_assets in the desired order.");
  if (operation.kind === "backgrounds" && operation.name === "default") throw new Error("Use set_default or clear_default for the reserved default background.");
  return operation;
}

export type VnAssetOperation = ReturnType<typeof parseVnAssetOperation>;

/** Validate a whole assignment batch before the executor mutates its draft. */
export function parseVnAssetOperations(input: unknown): VnAssetOperation[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide an asset operation or an operations array.");
  const record = input as Record<string, unknown>;
  if (record.operations === undefined) return [parseVnAssetOperation(input)];
  if (Object.keys(record).some(key => key !== "operations") || !Array.isArray(record.operations)
    || record.operations.length < 1 || record.operations.length > 50) {
    throw new Error("Provide 1 to 50 asset operations and no other top-level fields.");
  }
  return record.operations.map(parseVnAssetOperation);
}

function rowId(row: VnAssetRow & { spriteType?: string; spriteVariant?: string }) {
  if (row.spriteVariant) return JSON.stringify([row.spriteType ?? "normal", row.spriteVariant, row.name, row.variant]);
  return row.spriteType && row.spriteType !== "normal" ? JSON.stringify([row.spriteType, row.name, row.variant]) : vnAssetRowId(row);
}

function collection(world: WorldDefinition, scope: z.infer<typeof scopeSchema>) {
  const root = world.rootComponent;
  if (!isVnInterface(root) || !root) throw new Error("This card needs the Visual Novel interface before editing sprite or background assignments.");
  if (scope.openingId && !world.entries.some(entry => entry.role === "greeting" && entry.id === scope.openingId)) throw new Error("Opening not found. Use a stable greeting entry ID from list_vn_assets.");
  const filename = vnAssetFile(scope.kind);
  const source = root.files[filename];
  if (!source) throw new Error(`Missing ${filename}. Read the current interface before editing it.`);
  const map = scope.openingId ? readVnOpeningScenes(source)[scope.openingId] ?? {} : readVnAssetMap(source, scope.kind);
  const scopeId = scope.kind === "sprites" ? `sprites:${scope.npcGender ?? "character"}` : `backgrounds:${scope.openingId ? `opening:${scope.openingId}` : "global"}`;
  const rows: Array<VnAssetRow & { spriteType?: string; spriteVariant?: string }> = scope.npcGender
    ? Object.entries(readVnNpcSpritePools(source)[scope.npcGender]).map(([id, assetRef]) => ({ name: scope.npcGender!, variant: id, assetRef }))
    : scope.kind === "sprites" ? vnSpriteRows(source) : vnAssetRows(map, scope.kind);
  const orders = readVnAssetOrders(root.files[VN_ASSET_ORDER_FILE]);
  const order = orders[scopeId] ?? [];
  const positions = new Map(order.map((id, index) => [id, index]));
  return { root, filename, source, map, scopeId, orders, rows: rows.slice().sort((a, b) => (positions.get(rowId(a)) ?? Infinity) - (positions.get(rowId(b)) ?? Infinity)) };
}

/** Bounded inventory, including stable opening and row IDs, without executing authored code. */
export function executeListVnAssets(world: WorldDefinition, input: unknown) {
  const options = z.object({
    kind: z.enum(["sprites", "backgrounds"]).default("sprites"),
    openingId: z.string().min(1).max(200).optional(), npcGender: z.enum(["male", "female"]).optional(),
    spriteType: z.string().trim().min(1).max(100).optional(),
    spriteVariant: z.string().trim().max(100).optional(),
    name: z.string().max(200).optional(), offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }).parse(input);
  const openings = world.entries.filter(entry => entry.role === "greeting")
    .map(entry => ({ id: entry.id, name: entry.name, enabled: entry.enabled !== false }));
  try {
    const selected = collection(world, scopeSchema.parse(options));
    const rows = selected.rows.filter(row => (!options.spriteType || row.spriteType === options.spriteType)
      && (options.spriteVariant === undefined || (row.spriteVariant ?? "") === options.spriteVariant)
      && (!options.name || (options.npcGender ? row.variant : row.name).toLowerCase() === options.name.toLowerCase()));
    const nextOffset = options.offset + options.limit < rows.length ? options.offset + options.limit : null;
    const inventory = options.kind === "sprites" && !options.npcGender
      ? readVnSpriteInventory(selected.source, world.entries) : undefined;
    const characters = inventory?.characters.filter(name => !options.name || name.toLowerCase() === options.name.toLowerCase()) ?? [];
    const baseWardrobeDescriptions = Object.entries(inventory?.wardrobeDescriptions ?? {})
      .filter(([name]) => !options.name || name.toLowerCase() === options.name.toLowerCase())
      .flatMap(([name, descriptions]) => Object.entries(descriptions)
        .filter(([spriteType]) => !options.spriteType || spriteType === options.spriteType)
        .map(([spriteType, description]) => ({ name, spriteType, spriteVariant: "", description: description.slice(0, 2000), ...(description.length > 2000 ? { truncated: true } : {}) })));
    const variantWardrobeDescriptions = Object.entries(inventory?.variantWardrobeDescriptions ?? {})
      .flatMap(([name, types]) => Object.entries(types).flatMap(([spriteType, variants]) => Object.entries(variants)
        .map(([spriteVariant, description]) => ({ name, spriteType, spriteVariant, description: description.slice(0, 2000), ...(description.length > 2000 ? { truncated: true } : {}) }))));
    const wardrobeDescriptions = [...baseWardrobeDescriptions, ...variantWardrobeDescriptions].filter(row =>
      (!options.name || row.name.toLowerCase() === options.name.toLowerCase()) && (!options.spriteType || row.spriteType === options.spriteType)
      && (options.spriteVariant === undefined || row.spriteVariant === options.spriteVariant));
    const catalog = options.kind === "sprites" ? readVnSpriteConfig(selected.source) : undefined;
    const typeEntries = Object.entries(catalog?.types ?? {}).filter(([id]) => !options.spriteType || id === options.spriteType);
    const variantEntries = Object.entries(inventory?.variants ?? {}).flatMap(([spriteType, variants]) => Object.entries(variants)
      .map(([id, label]) => ({ spriteType, id, label }))).filter(row => (!options.spriteType || row.spriteType === options.spriteType)
        && (options.spriteVariant === undefined || row.id === options.spriteVariant));
    const outfitCoordinates = new Map<string, { name: string; spriteType: string; spriteVariant: string }>();
    for (const row of [...rows, ...wardrobeDescriptions]) if (options.kind === "sprites" && !options.npcGender) {
      const outfit = { name: row.name, spriteType: row.spriteType ?? "normal", spriteVariant: row.spriteVariant ?? "" };
      outfitCoordinates.set(JSON.stringify(outfit), outfit);
    }
    if (inventory && options.name && options.spriteType && Object.hasOwn(catalog!.types, options.spriteType)) {
      const spriteVariant = options.spriteVariant ?? "";
      if (spriteVariant && !Object.hasOwn(inventory.variants[options.spriteType] ?? {}, spriteVariant)) throw new Error("Choose a configured outfit variant.");
      const outfit = { name: options.name, spriteType: options.spriteType, spriteVariant };
      outfitCoordinates.set(JSON.stringify(outfit), outfit);
    }
    const outfits = [...outfitCoordinates.values()];
    const chapterOutfits = Object.entries(inventory?.chapterDefaults ?? {}).flatMap(([chapterOpeningId, characters]) =>
      Object.entries(characters).map(([name, selection]) => ({ chapterOpeningId, name, spriteType: selection.type, spriteVariant: selection.variant ?? "" })))
      .filter(row => (!options.name || row.name.toLowerCase() === options.name.toLowerCase()) && (!options.spriteType || row.spriteType === options.spriteType)
        && (options.spriteVariant === undefined || row.spriteVariant === options.spriteVariant));
    const nextInventoryOffset = (total: number) => options.offset + options.limit < total ? options.offset + options.limit : null;
    return {
      kind: options.kind, scope: selected.scopeId, openings, editable: true,
      total: rows.length, nextOffset, rows: rows.slice(options.offset, options.offset + options.limit).map(row => ({ id: rowId(row), ...row, ...(options.npcGender ? { spriteId: row.variant } : {}) })),
      characters: inventory ? characters.slice(options.offset, options.offset + options.limit) : undefined,
      characterTotal: inventory ? characters.length : undefined,
      nextCharacterOffset: inventory ? nextInventoryOffset(characters.length) : undefined,
      wardrobeDescriptions: inventory ? wardrobeDescriptions.slice(options.offset, options.offset + options.limit) : undefined,
      wardrobeDescriptionTotal: inventory ? wardrobeDescriptions.length : undefined,
      nextWardrobeDescriptionOffset: inventory ? nextInventoryOffset(wardrobeDescriptions.length) : undefined,
      outfits: inventory ? outfits.slice(options.offset, options.offset + options.limit).map(outfit => {
        const available = readVnSpriteOutfit(selected.source, outfit.name, outfit.spriteType, outfit.spriteVariant);
        return { ...outfit, availableExpressions: Object.keys(available.expressions), defaultEmotion: available.defaultEmotion ?? null };
      }) : undefined,
      chapterOutfits: inventory ? chapterOutfits.slice(options.offset, options.offset + options.limit) : undefined,
      chapterOutfitTotal: inventory ? chapterOutfits.length : undefined,
      nextChapterOutfitOffset: inventory ? nextInventoryOffset(chapterOutfits.length) : undefined,
      outfitTotal: inventory ? outfits.length : undefined,
      nextOutfitOffset: inventory ? nextInventoryOffset(outfits.length) : undefined,
      spriteVariants: inventory ? variantEntries.slice(options.offset, options.offset + options.limit) : undefined,
      spriteVariantTotal: inventory ? variantEntries.length : undefined,
      nextSpriteVariantOffset: inventory ? nextInventoryOffset(variantEntries.length) : undefined,
      spriteTypeTotal: catalog ? typeEntries.length : undefined,
      nextSpriteTypeOffset: catalog ? nextInventoryOffset(typeEntries.length) : undefined,
      defaultBackground: options.kind === "backgrounds" ? selected.map.default ?? null : undefined,
      spriteConfig: catalog ? { types: Object.fromEntries(typeEntries.slice(options.offset, options.offset + options.limit)), emotions: catalog.emotions } : undefined,
      spriteLimits: options.kind === "sprites" ? { types: null, emotions: VN_SPRITE_EMOTION_LIMIT, emotionWarning: VN_SPRITE_EMOTION_WARNING } : undefined,
      warnings: options.kind === "sprites" ? (() => {
        const config = readVnSpriteConfig(selected.source);
        return [...(Object.keys(config.emotions).length >= VN_SPRITE_EMOTION_WARNING ? ["This card has 20 or more emotions; the maximum is 30."] : [])];
      })() : undefined,
      npcDefaults: options.kind === "sprites" ? readVnNpcDefaults(selected.source) : undefined,
      help: "spriteVariant is an optional nested outfit ID, distinct from variant (emotion). Omit spriteVariant from listing for all outfits; empty selects Base. spriteVariants, outfits, spriteConfig.types and descriptions are independently paged by offset/limit; follow their next offsets. outfits.availableExpressions contains only actual images in that exact character/type/variant, never mandatory global emotion combinations. add_variant/rename_variant/remove_variant use spriteType, spriteVariant (rename/remove), label (add/rename). set_chapter_outfit/clear_chapter_outfit use chapterOpeningId (greeting ID), name and type/optional variant for set; chapter defaults do not duplicate sprite assignments. Character inventory includes lore names and description-only characters. characters and wardrobeDescriptions (name, spriteType, description) have independent totals and next offsets; each uses offset/limit. name filters all character fields, and spriteType filters assignments/descriptions. Descriptions are capped at 2,000 returned characters (truncated marks older longer values). Set or clear per-character outfit text with set_wardrobe_description plus name, spriteType and description; empty removes. Use {{sprite_wardrobe}} in character lore instead of fixed clothing. Character/type/emotion lists refresh from the current draft automatically. Character sprite rows include spriteType. Read spriteConfig for this card’s stable type/emotion IDs and display labels before assigning art or writing story tags. Omit spriteType for Normal assignments; omit it from inventory to list all sets. Catalog actions add_option/rename_option/remove_option take optionKind types or emotions, optionId (rename/remove), and label (add/rename). Renaming retains the stable ID. Normal and six built-in emotions are protected. Types have no fixed count cap; at most 30 emotion vocabulary entries per card; warn at 20 emotions. Removing a custom option removes its assignments but retains library images. Sprites are shared. Omit openingId for Global backgrounds; use a greeting ID for an opening collection. Opening scene/default images take precedence when present; Global remains the fallback. Use edit_vn_assets with owned @asset refs. Check get_image_sources for Danbooru artwork search/import and configured ComfyUI, Krea, or Forge Neo generation in Settings → AI Configuration. Krea can create NSFW scene backgrounds; keep backgrounds opaque. Sprite background removal runs only when transparent output is requested. Forge Neo uses its loaded checkpoint unless an override is configured. Backgrounds are complete opaque scenes; configured generation jobs start automatically, and the creator can cancel them from the image card.",
    };
  } catch (error) {
    return { editable: false, openings, error: error instanceof Error ? error.message : "Cannot read VN assets." };
  }
}

/** Execute against the current draft, so multiple same-turn assignments accumulate. */
export function applyVnAssetOperation(world: WorldDefinition, input: unknown) {
  const operation = parseVnAssetOperation(input);
  const selected = collection(world, operation);
  const { root, filename, source } = selected;
  if (operation.npcGender && !/export\s+function\s+npcSpriteFor\s*\(/.test(source)) throw new Error("This interface does not support NPC sprite pools. Update its NPC runtime first.");
  if (operation.action === "configure_npc_defaults" && !/export\s+function\s+npcSpriteSelection\s*\(/.test(source)) throw new Error("This interface does not support NPC fallback controls. Update its NPC runtime first.");
  let nextSource = source;
  let nextOrders = selected.orders;
  if (operation.action === "add_variant") {
    nextSource = addVnSpriteVariant(source, operation.spriteType!, operation.label!);
  } else if (operation.action === "rename_variant") {
    nextSource = renameVnSpriteVariant(source, operation.spriteType!, operation.spriteVariant!, operation.label!);
  } else if (operation.action === "remove_variant") {
    nextSource = removeVnSpriteVariant(source, operation.spriteType!, operation.spriteVariant!);
  } else if (operation.action === "set_chapter_outfit" || operation.action === "clear_chapter_outfit") {
    if (!world.entries.some(entry => entry.role === "greeting" && entry.id === operation.chapterOpeningId)) throw new Error("Chapter opening not found. Use a greeting ID from list_vn_assets.");
    nextSource = writeVnSpriteChapterDefault(source, [operation.chapterOpeningId!], operation.name!, operation.action === "clear_chapter_outfit" ? undefined : { type: operation.spriteType!, ...(operation.spriteVariant ? { variant: operation.spriteVariant } : {}) });
  } else if (operation.action === "set_wardrobe_description") {
    nextSource = writeVnSpriteWardrobeDescription(source, operation.name!, operation.spriteType!, operation.description!, operation.spriteVariant);
  } else if (operation.action === "add_option") {
    nextSource = addVnSpriteOption(source, operation.optionKind!, operation.label!);
  } else if (operation.action === "rename_option") {
    nextSource = renameVnSpriteOption(source, operation.optionKind!, operation.optionId!, operation.label!);
  } else if (operation.action === "remove_option") {
    nextSource = removeVnSpriteOption(source, operation.optionKind!, operation.optionId!);
  } else if (operation.action === "configure_npc_defaults") {
    nextSource = writeVnNpcDefaults(source, { ...readVnNpcDefaults(source),
      ...(operation.disabled === undefined ? {} : { disabled: operation.disabled }),
      ...(operation.mode === undefined ? {} : { mode: operation.mode }) });
  } else if (operation.action === "reorder") {
    const byId = new Map(selected.rows.map(row => [rowId(row), row]));
    // A subset may be reordered (e.g. one character); hidden slots remain in place.
    if (operation.order!.some(id => !byId.has(id))) throw new Error("Unknown row ID. Read list_vn_assets again before reordering.");
    const visible = new Set(operation.order);
    let cursor = 0;
    const reordered: VnAssetRow[] = selected.rows.map(row => visible.has(rowId(row)) ? byId.get(operation.order![cursor++]!)! : row);
    nextOrders = { ...nextOrders, [selected.scopeId]: reordered.map(rowId) };
  } else if (operation.npcGender) {
    const pools = readVnNpcSpritePools(source);
    if (operation.action === "remove" && !Object.hasOwn(pools[operation.npcGender], operation.name!)) throw new Error("NPC sprite not found.");
    nextSource = writeVnNpcSpritePools(source, operation.action === "assign"
      ? assignVnNpcSprite(pools, operation.npcGender, operation.name!, operation.assetRef!)
      : removeVnNpcSprite(pools, operation.npcGender, operation.name!));
  } else if (operation.kind === "sprites") {
    const spriteType = operation.spriteType ?? "normal";
    const emotion = operation.variant ?? "normal";
    if (operation.action === "assign") nextSource = assignVnSprite(source, operation.name!, spriteType, emotion, operation.assetRef!, operation.spriteVariant);
    if (operation.action === "remove") {
      const row = selected.rows.find(row => row.name.toLowerCase() === operation.name!.toLowerCase() && row.spriteType === spriteType && (row.spriteVariant ?? "") === (operation.spriteVariant ?? "") && row.variant === emotion);
      if (!row) throw new Error("Assignment not found. Read list_vn_assets for its exact wardrobe and emotion.");
      nextSource = removeVnSprite(source, row.name, spriteType, emotion, operation.spriteVariant);
    }
  } else {
    const baseVariant = "day";
    const variant = (operation.variant ?? baseVariant).toLowerCase();
    let map = selected.map;
    if (operation.action === "assign") map = assignVnAsset(map, operation.name!, variant, operation.assetRef!, baseVariant);
    if (operation.action === "remove") {
      const row = selected.rows.find(row => row.name.toLowerCase() === operation.name!.toLowerCase() && row.variant === variant);
      if (!row) throw new Error("Assignment not found. Read list_vn_assets for its exact variant.");
      map = removeVnAsset(map, row.name, row.variant);
    }
    if (operation.action === "set_default") map = operation.variant ? assignVnAsset(map, "default", variant, operation.assetRef!, "day") : { ...map, default: operation.assetRef! };
    if (operation.action === "clear_default") { map = { ...map }; delete map.default; }
    nextSource = operation.openingId
      ? writeVnOpeningScenes(source, operation.openingId, map, VN_BACKGROUND_TEMPLATE)
      : writeVnAssetMap(source, operation.kind, map);
  }
  root.files = { ...root.files, [filename]: nextSource,
    ...(operation.action === "reorder" ? { [VN_ASSET_ORDER_FILE]: JSON.stringify(nextOrders, null, 2) } : {}) };
  root.updatedAt = new Date().toISOString();
  return { filename: operation.action === "reorder" ? VN_ASSET_ORDER_FILE : filename, note: `${operation.action} ${selected.scopeId}` };
}
