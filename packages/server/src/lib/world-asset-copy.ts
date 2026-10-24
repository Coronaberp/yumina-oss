import { copyObject, deleteObject } from "./s3.js";
import type { assets } from "../db/schema.js";

type WorldAsset = typeof assets.$inferSelect;
const storedKey = (value: string) => !!value && !/^(?:https?:|data:|blob:|\/|@asset:)/i.test(value) && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Give card-owned uploads independent records and storage objects. Global
 * library assets remain linked through asset_references, as in the original. */
export async function prepareWorldAssetCopy(sourceAssets: WorldAsset[], worldId: string, imageRefs: string[]) {
  const replacements = new Map<string, string>();
  const objects = new Map<string, string>();
  const copiedKeys: string[] = [];
  const cleanup = async () => {
    await Promise.allSettled(copiedKeys.map(key => deleteObject(key)));
  };
  const objectKey = (source: string) => {
    if (!storedKey(source)) return source;
    let destination = objects.get(source);
    if (!destination) {
      const filename = source.split("/").pop() || "asset";
      destination = `worlds/${worldId}/copies/${crypto.randomUUID()}-${filename}`;
      objects.set(source, destination);
      replacements.set(source, destination);
      replacements.set(`/cdn/key/${Buffer.from(source).toString("base64url")}`, `/cdn/key/${Buffer.from(destination).toString("base64url")}`);
    }
    return destination;
  };
  const rows = sourceAssets.map(asset => {
    const id = crypto.randomUUID();
    replacements.set(asset.id, id);
    return { ...asset, id, worldId, url: objectKey(asset.url) };
  });
  for (const ref of imageRefs) objectKey(ref);
  try {
    const entries = [...objects];
    for (let offset = 0; offset < entries.length; offset += 4) {
      const batch = await Promise.allSettled(entries.slice(offset, offset + 4).map(async ([source, destination]) => {
        copiedKeys.push(destination);
        await copyObject(source, destination);
      }));
      const failed = batch.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  // Replace only known asset IDs/keys, including references in custom source,
  // compiled code and saved inactive interfaces. All other JSON stays intact.
  const encoded = new Map([...replacements].map(([from, to]) => [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]));
  const pattern = encoded.size ? new RegExp([...encoded.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join("|"), "g") : null;
  const remap = <T>(value: T): T => pattern ? JSON.parse(JSON.stringify(value).replace(pattern, match => encoded.get(match)!)) : structuredClone(value);
  return { rows, remap, cleanup };
}
