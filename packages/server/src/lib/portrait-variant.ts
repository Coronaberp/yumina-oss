import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isAnimatedPng } from './image-optimization.js';

interface PortraitStorage {
  head(key: string): Promise<{ contentType: string; contentLength: number; etag: string | null }>;
  read(key: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ buffer: Buffer }>;
  write(key: string, bytes: Buffer, contentType: string, options: { signal: AbortSignal }): Promise<void>;
}

/** One fixed, bounded thumbnail size for small portraits. Masters remain exact.
 * Source existence/version is checked even when its derived object is cached. */
export function createPortraitVariants(storage: PortraitStorage) {
  const pending = new Map<string, Promise<string | undefined>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (key: string): Promise<string | undefined> => {
    try {
      const source = await storage.head(key);
      if (!/^image\/(?:png|jpeg|webp)$/i.test(source.contentType) || !source.etag || source.contentLength > 32 * 1024 * 1024) return;
      const hash = createHash('sha256').update(key + '\0' + source.etag).digest('hex');
      const variant = `worlds/portrait-variants/v1/${hash}.webp`;
      if (pending.has(variant)) return pending.get(variant);
      if (pending.size >= 64) return;
      const work = (async () => {
        try { if ((await storage.head(variant)).contentType === 'image/webp') return variant; } catch { /* Create a missing thumbnail. */ }
        if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;
        try {
          const signal = AbortSignal.timeout(15_000);
          const { buffer } = await storage.read(key, { maxBytes: 32 * 1024 * 1024, signal });
          if (!buffer.length || buffer.length > 32 * 1024 * 1024 || isAnimatedPng(buffer)) return;
          const image = sharp(buffer, { animated: true, limitInputPixels: 40_000_000, failOn: 'warning' }).timeout({ seconds: 10 });
          const meta = await image.metadata();
          if ((meta.pages ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(meta.format ?? '')) return;
          const bytes = await image.rotate().resize(128, 128, { fit: 'inside', withoutEnlargement: true })
            .keepIccProfile().webp({ lossless: true, exact: true, effort: 3 }).toBuffer();
          await storage.write(variant, bytes, 'image/webp', { signal });
          return variant;
        } finally {
          const next = waiting.shift();
          if (next) next(); else active--;
        }
      })().catch(() => undefined);
      pending.set(variant, work);
      try { return await work; } finally { pending.delete(variant); }
    } catch { return; }
  };
}
