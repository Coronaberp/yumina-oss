import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assets, userAssets, worlds } from "../db/schema.js";
import type { SchemaChange } from "./studio-tools/index.js";
import { inspectOwnedVnImageRefs } from "./studio-tools/asset-catalog.js";
import { parseWorldMediaOperation } from "./studio-tools/world-media-tools.js";

/** Authorize the complete operation before returning portrait persistence data. */
export async function prepareStudioWorldMediaChange(
  userId: string,
  worldId: string,
  change: SchemaChange,
): Promise<{ thumbnailUrl?: string | null }> {
  if (!change.data?.world_media_operation) return {};
  if (change.entityType !== "settings" || change.id !== "world-media") {
    throw new Error("Use write_world_media to change card images.");
  }
  const operation = parseWorldMediaOperation(change.data.world_media_operation);
  const [owned] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
  if (!owned) throw new Error("World not found or not authorized");
  const refs = [operation.portraitAssetRef, operation.bannerAssetRef]
    .filter((ref): ref is string => typeof ref === "string");
  const [missing] = await inspectOwnedVnImageRefs(userId, worldId, refs);
  if (missing) throw new Error(`${missing.ref}: ${missing.reason}`);
  if (operation.portraitAssetRef === undefined) return {};
  if (operation.portraitAssetRef === null) return { thumbnailUrl: null };
  const id = operation.portraitAssetRef.slice("@asset:".length);
  const [libraryImage] = await db.select({ url: userAssets.url }).from(userAssets)
    .where(and(eq(userAssets.id, id), eq(userAssets.userId, userId), eq(userAssets.type, "image")));
  if (libraryImage) return { thumbnailUrl: libraryImage.url };
  const [worldImage] = await db.select({ url: assets.url }).from(assets)
    .where(and(eq(assets.id, id), eq(assets.worldId, worldId), eq(assets.type, "image")));
  if (worldImage) return { thumbnailUrl: worldImage.url };
  throw new Error("Image not found in this card or your asset library. Use list_assets first.");
}
