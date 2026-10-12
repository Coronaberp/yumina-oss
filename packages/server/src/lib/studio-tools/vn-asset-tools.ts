import {
  VN_ASSET_ORDER_FILE, VN_BACKGROUND_TEMPLATE, assignVnAsset, assignVnNpcSprite,
  isVnInterface, orderedVnAssetRows, readVnAssetMap, readVnAssetOrders,
  readVnNpcDefaults, readVnNpcSpritePools, readVnOpeningScenes, removeVnAsset,
  removeVnNpcSprite, vnAssetFile, vnAssetRowId, vnAssetRows, writeVnAssetMap,
  writeVnNpcDefaults, writeVnNpcSpritePools, writeVnOpeningScenes,
  type WorldDefinition, type VnAssetRow,
} from "@yumina/engine";
import { z } from "zod";

const scopeSchema = z.object({
  kind: z.enum(["sprites", "backgrounds"]),
  openingId: z.string().min(1).max(200).optional(),
  npcGender: z.enum(["male", "female"]).optional(),
}).superRefine((value, context) => {
  if (value.kind === "sprites" && value.openingId) context.addIssue({ code: "custom", message: "Sprites are shared across openings." });
  if (value.kind === "backgrounds" && value.npcGender) context.addIssue({ code: "custom", message: "NPC gender applies to sprites only." });
});

const editSchema = z.object({
  kind: z.enum(["sprites", "backgrounds"]),
  action: z.enum(["assign", "remove", "set_default", "clear_default", "reorder", "configure_npc_defaults"]),
  openingId: z.string().min(1).max(200).optional(),
  npcGender: z.enum(["male", "female"]).optional(),
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
  if ((operation.action === "assign" || operation.action === "remove") && !operation.name) throw new Error("A character, scene, or NPC sprite name is required.");
  if ((operation.action === "assign" || operation.action === "set_default") && !operation.assetRef) throw new Error("An image assetRef is required.");
  if ((operation.action === "set_default" || operation.action === "clear_default") && operation.kind !== "backgrounds") throw new Error("Default backgrounds apply to backgrounds only.");
  if (operation.action === "configure_npc_defaults" && (operation.kind !== "sprites" || (operation.disabled === undefined && operation.mode === undefined))) throw new Error("Provide a sprite default mode or disabled flag.");
  if (operation.action === "reorder" && (!operation.order || new Set(operation.order).size !== operation.order.length)) throw new Error("Provide unique row IDs from list_vn_assets in the desired order.");
  if (operation.name === "default") throw new Error("Use set_default or clear_default for the reserved default background.");
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

function collection(world: WorldDefinition, scope: z.infer<typeof scopeSchema>) {
  const root = world.rootComponent;
  if (!isVnInterface(root) || !root) throw new Error("This card needs the Visual Novel interface before editing sprite or background assignments.");
  if (scope.openingId && !world.entries.some(entry => entry.role === "greeting" && entry.id === scope.openingId)) throw new Error("Opening not found. Use a stable greeting entry ID from list_vn_assets.");
  const filename = vnAssetFile(scope.kind);
  const source = root.files[filename];
  if (!source) throw new Error(`Missing ${filename}. Read the current interface before editing it.`);
  const map = scope.openingId ? readVnOpeningScenes(source)[scope.openingId] ?? {} : readVnAssetMap(source, scope.kind);
  const scopeId = scope.kind === "sprites" ? `sprites:${scope.npcGender ?? "character"}` : `backgrounds:${scope.openingId ? `opening:${scope.openingId}` : "global"}`;
  const rows = scope.npcGender
    ? Object.entries(readVnNpcSpritePools(source)[scope.npcGender]).map(([id, assetRef]) => ({ name: scope.npcGender!, variant: id, assetRef }))
    : vnAssetRows(map, scope.kind);
  const orders = readVnAssetOrders(root.files[VN_ASSET_ORDER_FILE]);
  return { root, filename, source, map, scopeId, orders, rows: orderedVnAssetRows(rows, orders[scopeId]) };
}

/** Bounded inventory, including stable opening and row IDs, without executing authored code. */
export function executeListVnAssets(world: WorldDefinition, input: unknown) {
  const options = z.object({
    kind: z.enum(["sprites", "backgrounds"]).default("sprites"),
    openingId: z.string().min(1).max(200).optional(), npcGender: z.enum(["male", "female"]).optional(),
    name: z.string().max(200).optional(), offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }).parse(input);
  const openings = world.entries.filter(entry => entry.role === "greeting")
    .map(entry => ({ id: entry.id, name: entry.name, enabled: entry.enabled !== false }));
  try {
    const selected = collection(world, scopeSchema.parse(options));
    const rows = options.name ? selected.rows.filter(row => (options.npcGender ? row.variant : row.name).toLowerCase() === options.name!.toLowerCase()) : selected.rows;
    const nextOffset = options.offset + options.limit < rows.length ? options.offset + options.limit : null;
    return {
      kind: options.kind, scope: selected.scopeId, openings, editable: true,
      total: rows.length, nextOffset, rows: rows.slice(options.offset, options.offset + options.limit).map(row => ({ id: vnAssetRowId(row), ...row, ...(options.npcGender ? { spriteId: row.variant } : {}) })),
      defaultBackground: options.kind === "backgrounds" ? selected.map.default ?? null : undefined,
      npcDefaults: options.kind === "sprites" ? readVnNpcDefaults(selected.source) : undefined,
      help: "Sprites are shared. Omit openingId for Global backgrounds; use a greeting ID for an opening collection. Opening scene/default images take precedence when present; Global remains the fallback. Use edit_vn_assets with owned @asset refs. Check get_image_sources for Danbooru artwork search/import and configured ComfyUI, Krea, or Forge Neo generation in Settings → AI Configuration. Krea can create NSFW scene backgrounds; keep backgrounds opaque. Sprite background removal runs only when transparent output is requested. Forge Neo uses its loaded checkpoint unless an override is configured. Backgrounds are complete opaque scenes; configured generation jobs start automatically, and the creator can cancel them from the image card.",
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
  if (operation.action === "configure_npc_defaults") {
    nextSource = writeVnNpcDefaults(source, { ...readVnNpcDefaults(source),
      ...(operation.disabled === undefined ? {} : { disabled: operation.disabled }),
      ...(operation.mode === undefined ? {} : { mode: operation.mode }) });
  } else if (operation.action === "reorder") {
    const byId = new Map(selected.rows.map(row => [vnAssetRowId(row), row]));
    // A subset may be reordered (e.g. one character); hidden slots remain in place.
    if (operation.order!.some(id => !byId.has(id))) throw new Error("Unknown row ID. Read list_vn_assets again before reordering.");
    const visible = new Set(operation.order);
    let cursor = 0;
    const reordered: VnAssetRow[] = selected.rows.map(row => visible.has(vnAssetRowId(row)) ? byId.get(operation.order![cursor++]!)! : row);
    nextOrders = { ...nextOrders, [selected.scopeId]: reordered.map(vnAssetRowId) };
  } else if (operation.npcGender) {
    const pools = readVnNpcSpritePools(source);
    if (operation.action === "remove" && !Object.hasOwn(pools[operation.npcGender], operation.name!)) throw new Error("NPC sprite not found.");
    nextSource = writeVnNpcSpritePools(source, operation.action === "assign"
      ? assignVnNpcSprite(pools, operation.npcGender, operation.name!, operation.assetRef!)
      : removeVnNpcSprite(pools, operation.npcGender, operation.name!));
  } else {
    const baseVariant = operation.kind === "sprites" ? "normal" : "day";
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
