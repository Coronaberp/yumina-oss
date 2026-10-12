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
/** Normalize to a decoded PNG and remove embedded provider/workflow metadata. */
export async function normalizeGeneratedRaster(bytes: Buffer, signal: AbortSignal, requireTransparentPng = false) {
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
    const output = await image.png().toBuffer();
    signal.throwIfAborted();
    if (output.length > MAX_IMAGE_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The generated PNG exceeds the 20 MB size limit.', 413);
    return { bytes: output, width: metadata.width, height: metadata.height };
  } catch (error) { signal.throwIfAborted(); if (error instanceof GenerationError) throw error; throw new GenerationError('INVALID_IMAGE', 'The provider did not return a valid supported raster image.', 503); }
  finally { release(); }
}
export type GenerationTransaction = {
  write(key: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
  register(asset: GeneratedAsset, key: string, bytes: number): Promise<void>;
};
/** Caller holds the same owner lock as normal uploads while registering the image. */
export async function commitGeneratedAsset(userId: string, bytes: Buffer, source: GeneratedSource, tx: GenerationTransaction, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = randomUUID(); const filename = `${source.provider}-${source.imageKind}${source.assetRole === 'original' ? '-original' : ''}-${id}.png`;
  const key = `users/${userId}/image/${id}-${randomUUID()}.png`;
  const asset: GeneratedAsset = { id, ref: `@asset:${id}`, filename, source };
  await tx.write(key, bytes, signal);
  signal.throwIfAborted();
  await tx.register(asset, key, bytes.length);
  signal.throwIfAborted();
  return asset;
}

/** Register original and final rasters in the same caller-owned DB transaction. */
export async function commitGeneratedAssetBundle(userId: string, finalBytes: Buffer, source: GeneratedSource,
  original: { bytes: Buffer; source: GeneratedSource } | undefined, tx: GenerationTransaction, signal: AbortSignal) {
  const originalAsset = original ? await commitGeneratedAsset(userId, original.bytes,
    { ...original.source, assetRole: 'original', requestId: undefined, originalAssetId: undefined }, tx, signal) : undefined;
  const finalSource: GeneratedSource = { ...source, assetRole: 'final', ...(originalAsset ? { originalAssetId: originalAsset.id } : {}) };
  return commitGeneratedAsset(userId, finalBytes, finalSource, tx, signal);
}
