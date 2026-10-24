import { worldDefinitionSchema, type WorldDefinition } from "@yumina/engine";
import { z } from "zod";

const imageRefSchema = z.string().regex(/^@asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Use an owned image @asset:UUID reference from list_assets.");
// Reuse the engine's numeric bounds and defaults without parsing the full card.
const framingSchema = worldDefinitionSchema.shape.coverCrop.unwrap().strict();
const operationSchema = z.object({
  portraitAssetRef: imageRefSchema.nullable().optional(),
  bannerAssetRef: imageRefSchema.nullable().optional(),
  coverCrop: framingSchema.nullable().optional(),
  bannerCrop: framingSchema.nullable().optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined), "Provide at least one card-media field.");

export type WorldMediaOperation = z.infer<typeof operationSchema>;

/** Pure syntax validation. The route must authorize every non-null image ref. */
export function parseWorldMediaOperation(input: unknown): WorldMediaOperation {
  return operationSchema.parse(input);
}

/** Only schema media is mutated here; portrait persistence stays transactional. */
export function applyWorldMediaOperation(world: WorldDefinition, input: unknown): WorldMediaOperation {
  const operation = parseWorldMediaOperation(input);
  if (operation.bannerAssetRef !== undefined) world.bannerImageUrl = operation.bannerAssetRef ?? "";
  for (const field of ["coverCrop", "bannerCrop"] as const) {
    const crop = operation[field];
    if (crop === null) delete world[field];
    else if (crop !== undefined) world[field] = crop;
  }
  return operation;
}

function readFraming(value: unknown) {
  const parsed = framingSchema.strip().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Narrow metadata only. Never infer the live portrait from deprecated avatar. */
export function readWorldMedia(world: WorldDefinition, thumbnailUrl?: string | null) {
  const portrait = typeof thumbnailUrl === "string" && thumbnailUrl ? thumbnailUrl : null;
  const banner = typeof world.bannerImageUrl === "string" && world.bannerImageUrl ? world.bannerImageUrl : null;
  return {
    _type: "worldMedia" as const,
    thumbnailUrl: portrait,
    bannerAssetRef: banner,
    coverCrop: readFraming(world.coverCrop),
    bannerCrop: readFraming(world.bannerCrop),
    pageBannerImageUrl: banner ?? portrait,
    pageBannerSource: banner ? "banner" as const : portrait ? "portrait" as const : "none" as const,
    help: "Portrait cover and page banner are independent. thumbnailUrl is the actual working portrait value and may be a legacy URL or storage key; it is not an invented asset reference. The portrait is used on card grids. The optional wide page banner uses 16:5 and defaults to x=0, y=0, zoom=1, fit=contain when bannerCrop is absent. An empty banner falls back to the portrait with existing desktop/mobile framing. Use write_world_media with owned @asset:UUID refs. Omitted fields preserve current values; null clears only the supplied image or framing. Crop objects replace that framing; x/y are -45..45, zoom 0.25..3, and fit is cover or contain.",
  };
}
