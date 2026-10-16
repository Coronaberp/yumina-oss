import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { userAssets } from '../../db/schema.js';
import { isS3Configured, putObject, deleteObject } from '../s3.js';
import { mediaRows } from '../session-media-service.js';
import { sessionMedia } from '../session-media.js';
import { GenerationError, type GeneratedAsset, type GeneratedSource } from './config.js';
import { normalizeGeneratedRaster, commitGeneratedAssetBundle } from './asset-store.js';
import type { GeneratedStorage } from './service.js';
export const generatedImageStorage: GeneratedStorage = {
  async findRequest(userId, requestId, signal) {
    signal.throwIfAborted();
    const [saved] = await mediaRows<{ id: string; filename: string; metadata: GeneratedSource }>(db, sql`SELECT a.id,a.filename,s.metadata FROM image_generation_requests r JOIN user_assets a ON a.id=r.asset_id JOIN generated_image_sources s ON s.asset_id=a.id WHERE r.user_id=${userId} AND r.request_id=${requestId} AND r.state='succeeded' AND a.user_id=${userId} AND s.user_id=${userId}`);
    signal.throwIfAborted();
    return saved ? { id: saved.id, ref: `@asset:${saved.id}`, filename: saved.filename, source: saved.metadata } : undefined;
  },
  async claimRequest(userId, requestId, signal) {
    signal.throwIfAborted();
    return db.transaction(async tx => {
      await sessionMedia.lockOwner(tx, userId);
      signal.throwIfAborted();
      const [claimed] = await mediaRows<{ request_id: string }>(tx, sql`INSERT INTO image_generation_requests(user_id,request_id,state)
        VALUES(${userId},${requestId},'pending') ON CONFLICT(user_id,request_id) DO NOTHING RETURNING request_id`);
      if (claimed) return undefined;
      const [saved] = await mediaRows<{ id: string; filename: string; metadata: GeneratedSource }>(tx, sql`SELECT a.id,a.filename,s.metadata
        FROM image_generation_requests r JOIN user_assets a ON a.id=r.asset_id JOIN generated_image_sources s ON s.asset_id=a.id
        WHERE r.user_id=${userId} AND r.request_id=${requestId} AND r.state='succeeded' AND a.user_id=${userId} AND s.user_id=${userId}`);
      if (saved) return { id: saved.id, ref: `@asset:${saved.id}`, filename: saved.filename, source: saved.metadata };
      throw new GenerationError('REQUEST_ALREADY_SUBMITTED', 'This image request was already submitted. Check the provider queue or confirm a new request.', 409);
    });
  },
  async failRequest(userId, requestId) {
    await db.execute(sql`UPDATE image_generation_requests SET state='failed',updated_at=NOW() WHERE user_id=${userId} AND request_id=${requestId} AND state='pending'`);
  },
  async preflight(userId, signal) {
    signal.throwIfAborted();
    if (!isS3Configured()) throw new GenerationError('STORAGE_UNAVAILABLE', 'Asset storage is not configured.', 503);
    signal.throwIfAborted();
  },
  async validate(bytes, signal) { await normalizeGeneratedRaster(bytes, signal, false, false); },
  async save(userId, bytes, source, signal, artifacts) {
    const image = await normalizeGeneratedRaster(bytes, signal, source.transparent === true);
    const metadata = { ...source, width: image.width, height: image.height };
    const original = artifacts?.originalBytes ? await normalizeGeneratedRaster(artifacts.originalBytes, signal) : undefined;
    const originalSource = original ? { ...source, ...artifacts?.originalSource, imageKind: 'image' as const, requestId: undefined,
      originalAssetId: undefined, assetRole: 'original' as const, greenRemoved: false, width: original.width, height: original.height } : undefined;
    const writes: Array<{ key: string; assetId?: string }> = [];
    try {
      return await db.transaction(async tx => {
        signal.throwIfAborted();
        await sessionMedia.lockOwner(tx, userId);
        const result = await commitGeneratedAssetBundle(userId, image.bytes, metadata,
          original && originalSource ? { bytes: original.bytes, source: originalSource } : undefined, {
          async write(key, data, writeSignal, mimeType) { writes.push({ key }); await putObject(key, data, mimeType, { signal: writeSignal }); },
          async register(asset, key, length, mimeType) {
            const write = [...writes].reverse().find(item => item.key === key);
            if (write) write.assetId = asset.id;
            await tx.insert(userAssets).values({ id: asset.id, userId, type: 'image', filename: asset.filename, url: key, sizeBytes: length, mimeType, isPublic: false });
            await tx.execute(sql`INSERT INTO generated_image_sources(asset_id,user_id,provider,metadata) VALUES(${asset.id},${userId},${asset.source.provider},${JSON.stringify(asset.source)}::jsonb)`);
            if (asset.source.requestId) await tx.execute(sql`UPDATE image_generation_requests SET state='succeeded',asset_id=${asset.id},updated_at=NOW() WHERE user_id=${userId} AND request_id=${asset.source.requestId} AND state='pending'`);
          },
        }, signal);
        signal.throwIfAborted();
        return result;
      });
    } catch (error) {
      // Unique object keys are independently checked because the bundle may have written two files.
      for (const written of writes) {
        const registered = written.assetId ? await db.select({ id: userAssets.id }).from(userAssets).where(eq(userAssets.id, written.assetId)).limit(1).catch(() => null) : [];
        if (registered?.length === 0) await deleteObject(written.key).catch(() => {});
      }
      if (signal.aborted) throw error;
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('SAVE_FAILED', 'The generated image could not be saved. Try again later.', 503);
    }
  },
};
