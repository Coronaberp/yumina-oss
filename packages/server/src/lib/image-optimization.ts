import sharp from "sharp";

export interface UploadedImage {
  key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface ImageStorage {
  read(key: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ buffer: Buffer; contentType: string }>;
  write(key: string, bytes: Buffer, contentType: string, options: { signal: AbortSignal }): Promise<void>;
}

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
let active = 0;
const waiting: Array<() => void> = [];

export function losslessWebpKey(key: string): string {
  return `${key}.lossless.webp`;
}

function convertedAsset(asset: UploadedImage, bytes: Buffer): UploadedImage {
  return { key: losslessWebpKey(asset.key), filename: `${asset.filename.replace(/\.[^./\\]+$/, "") || "image"}.webp`, mimeType: "image/webp", sizeBytes: bytes.length };
}

// libvips can read an APNG's first frame as a still PNG. Inspect real chunk
// boundaries before decoding so an animation never silently loses its frames.
export function isAnimatedPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return true; // Inconclusive: preserve the original.
    offset = end;
  }
  return true;
}

/**
 * Optimize a NEW upload before registering/publishing it. Full resolution,
 * lossless pixels and alpha; keep animation, high bit depth, unsupported files,
 * and originals that are smaller. The source remains intact until DB commit.
 * Storage is injected so both S3 and local disk use the same conversion.
 */
export async function optimizeUploadedImage(asset: UploadedImage, storage: ImageStorage): Promise<UploadedImage> {
  if (!SUPPORTED_MIMES.has(asset.mimeType.toLowerCase()) || asset.sizeBytes > MAX_INPUT_BYTES) return asset;
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
  try {
    const signal = AbortSignal.timeout(15_000);
    let buffer: Buffer;
    try {
      ({ buffer } = await storage.read(asset.key, { maxBytes: MAX_INPUT_BYTES, signal }));
    } catch {
      // Successful confirmation may have removed the staging original. Reuse
      // the published variant when that confirmation is retried.
      const stored = await storage.read(losslessWebpKey(asset.key), { maxBytes: MAX_INPUT_BYTES, signal });
      if (stored.contentType !== "image/webp" || (await sharp(stored.buffer).metadata()).format !== "webp") return asset;
      return convertedAsset(asset, stored.buffer);
    }
    if (!buffer.length || buffer.length > MAX_INPUT_BYTES || isAnimatedPng(buffer)) return asset;
    const image = sharp(buffer, { animated: true, limitInputPixels: 40_000_000, failOn: "warning" }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1 || metadata.depth !== "uchar") return asset;
    // exact also preserves the RGB values of fully transparent pixels.
    const bytes = await image.rotate().keepIccProfile().webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
    if (bytes.length >= buffer.length) return asset;
    const key = losslessWebpKey(asset.key);
    await storage.write(key, bytes, "image/webp", { signal });
    return convertedAsset(asset, bytes);
  } catch {
    // Optimization is optional: decoding/storage failures keep the upload usable.
    return asset;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
