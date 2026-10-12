import sharp from 'sharp';
import { DanbooruError, DANBOORU_MAX_BYTES, type DanbooruPost, type DanbooruImportedAsset } from './danbooru.js';
import { createHash, randomUUID } from 'node:crypto';
let activeDecodes = 0;
/** Full bounded decode, rather than trusting the filename or Content-Type. */
export async function validateDanbooruRaster(bytes: Buffer) {
  if (!bytes.length || bytes.length > DANBOORU_MAX_BYTES) throw new DanbooruError('FILE_TOO_LARGE', 'The image must be at most 20 MB.', 413);
  if (activeDecodes >= 2) throw new DanbooruError('IMAGE_PROCESSOR_BUSY', 'The image processor is busy. Try again shortly.', 503);
  activeDecodes++;
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning', animated: true }).timeout({ seconds: 15 });
    const info = await image.metadata();
    const formats: Record<string, { mimeType: string; extension: string }> = {
      jpeg: { mimeType: 'image/jpeg', extension: 'jpg' }, png: { mimeType: 'image/png', extension: 'png' },
      webp: { mimeType: 'image/webp', extension: 'webp' }, gif: { mimeType: 'image/gif', extension: 'gif' },
      avif: { mimeType: 'image/avif', extension: 'avif' },
    };
    const format = info.format === 'heif' && info.compression === 'av1' ? formats.avif : formats[info.format ?? ''];
    if (!format || !info.width || !info.height || info.width * info.height > 40_000_000 || (info.pages ?? 1) > 200) throw new Error('invalid');
    await image.stats(); // Forces libvips to decode actual raster pixels.
    return { ...format, width: info.width, height: info.pageHeight ?? info.height };
  } catch { throw new DanbooruError('UNSUPPORTED_IMAGE', 'The downloaded file is not a valid supported raster image.'); }
  finally { activeDecodes--; }
}
export function danbooruAssetId(userId: string, postId: number): string {
  const bytes = createHash('sha256').update(JSON.stringify(['yumina-danbooru-import-v1', userId, postId])).digest().subarray(0, 16);
  // Deterministic namespace-derived UUID layout; conforms to the existing @asset parser.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type DanbooruAssetStorage = {
  configured(): boolean;
  validate(bytes: Buffer): Promise<{ mimeType: string; extension: string; width: number; height: number }>;
  persist(userId: string, bytes: Buffer, source: DanbooruPost, image: Awaited<ReturnType<DanbooruAssetStorage['validate']>>, filename?: string, signal?: AbortSignal): Promise<DanbooruImportedAsset>;
};
export function createDanbooruAssetStore(storage: DanbooruAssetStorage) {
  return async (userId: string, bytes: Buffer, source: DanbooruPost, filename?: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!storage.configured()) throw new DanbooruError('STORAGE_UNAVAILABLE', 'Asset storage is not configured.', 503);
    const image = await storage.validate(bytes);
    signal?.throwIfAborted();
    return storage.persist(userId, bytes, { ...source, width: image.width, height: image.height }, image, filename, signal);
  };
}

export type DanbooruImageInfo = Awaited<ReturnType<typeof validateDanbooruRaster>>;
export type DanbooruImportTransaction = {
  existing(id: string): Promise<DanbooruImportedAsset | undefined>;
  write(key: string, bytes: Buffer, mime: string): Promise<void>;
  register(asset: DanbooruImportedAsset, key: string, bytes: number, mime: string): Promise<void>;
};
/** Caller holds the same account lock used by normal asset registration. */
export async function commitDanbooruAsset(userId: string, bytes: Buffer, source: DanbooruPost, image: DanbooruImageInfo,
  tx: DanbooruImportTransaction, requestedFilename?: string, signal?: AbortSignal): Promise<DanbooruImportedAsset> {
  signal?.throwIfAborted();
  const id = danbooruAssetId(userId, source.postId);
  const existing = await tx.existing(id);
  if (existing) return existing;
  const basename = requestedFilename ? requestedFilename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) : `danbooru-${source.postId}`;
  const filename = `${basename || `danbooru-${source.postId}`}.${image.extension}`;
  const key = `users/${userId}/image/${id}-${randomUUID()}-${filename}`;
  const asset = { id, ref: `@asset:${id}`, filename, source };
  signal?.throwIfAborted();
  await tx.write(key, bytes, image.mimeType);
  signal?.throwIfAborted();
  await tx.register(asset, key, bytes.length, image.mimeType);
  return asset;
}
