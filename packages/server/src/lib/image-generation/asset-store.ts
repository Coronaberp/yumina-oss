import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { GenerationError, type GeneratedAsset, type GeneratedSource } from './config.js';
import { MAX_IMAGE_BYTES } from './transport.js';
let activeDecodes = 0;
const waitingDecodes: Array<{ start(): void }> = [];
function acquireDecode(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const release = () => {
      activeDecodes--;
      while (activeDecodes < 2 && waitingDecodes.length) waitingDecodes.shift()!.start();
    };
    const waiter = { start() {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason);return; }
      activeDecodes++;resolve(release);
    } };
    const abort = () => {
      const index = waitingDecodes.indexOf(waiter);
      if (index >= 0) waitingDecodes.splice(index, 1);
      reject(signal.reason);
    };
    if (activeDecodes < 2) waiter.start();
    else { waitingDecodes.push(waiter);signal.addEventListener('abort', abort, { once: true }); }
  });
}
export type GeneratedRasterMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif' | 'image/heif';
const extensions: Record<GeneratedRasterMime, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heif': 'heif',
};
/** Sharp does not decode APNG frames. Reject rather than validate only the first
 * frame or silently flatten a provider animation. Ordinary PNG remains valid. */
function isAnimatedPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}
/** Validate the full decoded raster, but retain the complete provider file.
 * Animation is decoded across every frame under the same total pixel budget. */
export async function validateGeneratedRaster(bytes: Buffer, signal: AbortSignal, requireTransparentPng = false) {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The generated image must be at most 20 MB.', 413);
  const release = await acquireDecode(signal);
  try {
    signal.throwIfAborted();
    if (isAnimatedPng(bytes)) throw new GenerationError('INVALID_IMAGE', 'Animated PNG provider output cannot be fully validated. No image was saved.', 503);
    const image = sharp(bytes, { animated: true, limitInputPixels: 40_000_000, failOn: 'warning' }).timeout({ seconds: 15 });
    const metadata = await image.metadata();
    const mimeType: GeneratedRasterMime | undefined = metadata.format === 'heif'
      ? metadata.compression === 'av1' ? 'image/avif' : 'image/heif'
      : metadata.format && ['png', 'jpeg', 'webp', 'gif', 'avif'].includes(metadata.format)
        ? `image/${metadata.format}` as GeneratedRasterMime : undefined;
    // GIF's logical canvas can exceed its decoded frame rectangles. Re-encoding
    // used to discard that header; immutable originals must bound it explicitly.
    const width = mimeType === 'image/gif' ? bytes.readUInt16LE(6) : metadata.width;
    const height = mimeType === 'image/gif' ? bytes.readUInt16LE(8) : metadata.pageHeight ?? metadata.height;
    const pages = metadata.pages ?? 1;
    if (!mimeType || !width || !height || !Number.isSafeInteger(pages) || pages < 1 || width * height * pages > 40_000_000) throw new Error('invalid raster');
    // Metadata-only inspection is insufficient: decode pixel data, including all
    // GIF/WebP frames, without materializing another full encoded image.
    const transparent = !(await image.stats()).isOpaque;
    if (requireTransparentPng && (mimeType !== 'image/png' || !metadata.hasAlpha || !transparent))
      throw new GenerationError('SPRITE_NOT_TRANSPARENT', 'The provider returned an opaque sprite. Request an isolated character with a transparent background.', 503);
    signal.throwIfAborted();
    return { bytes, width, height, pages, mimeType, transparent };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GenerationError) throw error;
    throw new GenerationError('INVALID_IMAGE', 'The provider did not return a valid supported raster image.', 503);
  } finally { release(); }
}

/** Explicit derivative only: remove embedded metadata and encode PNG/lossless
 * WebP. The caller must retain the provider original independently. */
export async function normalizeGeneratedRaster(bytes: Buffer, signal: AbortSignal, requireTransparentPng = false, optimizeForStorage = true) {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The generated image must be at most 20 MB.', 413);
  // Completed provider outputs wait for bounded decoding rather than failing
  // after generation. Cancelling a waiting image removes only its own slot.
  const release = await acquireDecode(signal);
  try {
    signal.throwIfAborted();
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).timeout({ seconds: 15 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000 || (metadata.pages ?? 1) > 1) throw new Error('invalid raster');
    if (requireTransparentPng && (metadata.format !== 'png' || !metadata.hasAlpha || (await image.stats()).isOpaque))
      throw new GenerationError('SPRITE_NOT_TRANSPARENT', 'The provider returned an opaque sprite. Request an isolated character with a transparent background.', 503);
    let output = await image.png().toBuffer();
    if (optimizeForStorage && metadata.depth === 'uchar') {
      const webp = await sharp(output).webp({ lossless: true, exact: true, effort: 6 }).timeout({ seconds: 15 }).toBuffer();
      if (webp.length < output.length) output = webp;
    }
    signal.throwIfAborted();
    if (output.length > MAX_IMAGE_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The generated image exceeds the 20 MB size limit.', 413);
    return { bytes: output, width: metadata.width, height: metadata.height,
      mimeType: output.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' as const : 'image/png' as const };
  } catch (error) { signal.throwIfAborted(); if (error instanceof GenerationError) throw error; throw new GenerationError('INVALID_IMAGE', 'The provider did not return a valid supported raster image.', 503); }
  finally { release(); }
}
export type GenerationTransaction = {
  /** A canonical master store may return a different immutable physical key. */
  write(key: string, bytes: Buffer, signal: AbortSignal, mimeType: string): Promise<void | string>;
  register(asset: GeneratedAsset, key: string, bytes: number, mimeType: string): Promise<void>;
};
/** Caller holds the same owner lock as normal uploads while registering the image. */
export async function commitGeneratedAsset(userId: string, bytes: Buffer, source: GeneratedSource, tx: GenerationTransaction, signal: AbortSignal, validatedMimeType?: GeneratedRasterMime) {
  signal.throwIfAborted();
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const mimeType = validatedMimeType ?? (webp ? 'image/webp' : 'image/png');
  const extension = extensions[mimeType];
  const id = randomUUID(); const filename = `${source.provider}-${source.imageKind}${source.assetRole === 'original' ? '-original' : ''}-${id}.${extension}`;
  const key = `users/${userId}/image/${id}-${randomUUID()}.${extension}`;
  const asset: GeneratedAsset = { id, ref: `@asset:${id}`, filename, source };
  const storedKey = await tx.write(key, bytes, signal, mimeType) ?? key;
  signal.throwIfAborted();
  await tx.register(asset, storedKey, bytes.length, mimeType);
  signal.throwIfAborted();
  return asset;
}

/** Register original and final rasters in the same caller-owned DB transaction. */
export async function commitGeneratedAssetBundle(userId: string, finalBytes: Buffer, source: GeneratedSource,
  original: { bytes: Buffer; source: GeneratedSource; mimeType?: GeneratedRasterMime } | undefined, tx: GenerationTransaction, signal: AbortSignal,
  mimeType?: GeneratedRasterMime) {
  const originalAsset = original ? await commitGeneratedAsset(userId, original.bytes,
    { ...original.source, assetRole: 'original', requestId: undefined, originalAssetId: undefined }, tx, signal, original.mimeType) : undefined;
  const finalSource: GeneratedSource = { ...source, assetRole: 'final', ...(originalAsset ? { originalAssetId: originalAsset.id } : {}) };
  return commitGeneratedAsset(userId, finalBytes, finalSource, tx, signal, mimeType);
}
