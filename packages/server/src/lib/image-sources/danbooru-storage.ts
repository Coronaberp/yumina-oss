import { sql, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { userAssets } from '../../db/schema.js';
import { isS3Configured, deleteObject } from '../s3.js';
import { imageMasters, isImageMasterKey } from "../image-masters.js";
import { sessionMedia } from '../session-media.js';
import { mediaRows } from '../session-media-service.js';
import { DanbooruError, type DanbooruPost } from './danbooru.js';
import { createDanbooruAssetStore, validateDanbooruRaster, danbooruAssetId, commitDanbooruAsset } from './danbooru-import.js';
export const storeDanbooruAsset = createDanbooruAssetStore({
  configured: isS3Configured,
  validate: validateDanbooruRaster,
  async persist(userId, bytes, source, image, requestedFilename, signal) {
    signal?.throwIfAborted();
    const id = danbooruAssetId(userId, source.postId);
    let objectWritten: string | undefined;
    let master: Awaited<ReturnType<typeof imageMasters.store>> | undefined;
    try {
      return await db.transaction(async tx => {
        await sessionMedia.lockOwner(tx, userId);
        signal?.throwIfAborted();
        return commitDanbooruAsset(userId, bytes, source, image, {
          async existing(assetId) {
            const [row] = await mediaRows<{id:string;filename:string;metadata:DanbooruPost}>(tx, sql`SELECT a.id,a.filename,s.metadata FROM user_assets a JOIN danbooru_asset_sources s ON s.asset_id=a.id WHERE a.id=${assetId} AND a.user_id=${userId} AND s.user_id=${userId} AND s.post_id=${source.postId}`);
            return row ? { id: row.id, ref: `@asset:${row.id}`, filename: row.filename, source: row.metadata } : undefined;
          },
          async write(_key, data, mime) {
            master = await imageMasters.store({ userId, access: 'public', bytes: data, mimeType: mime,
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }, tx);
            objectWritten = master.key;
          },
          async register(asset) {
            if (!master) throw new Error('Image master was not persisted');
            await tx.insert(userAssets).values({ id: asset.id, userId, type: 'image', filename: asset.filename, url: master.key,
              sizeBytes: master.originalSize, mimeType: master.mimeType, isPublic: false, sourceAssetId: `danbooru:${source.postId}` });
            await tx.execute(sql`INSERT INTO danbooru_asset_sources(asset_id,user_id,post_id,metadata)
              VALUES(${asset.id},${userId},${source.postId},${JSON.stringify(source)}::jsonb)`);
          },
        }, requestedFilename, signal);
      });
    } catch (error) {
      // Shared canonical masters may have sibling references or an uncertain
      // commit outcome. Retain them; safe orphan reclamation is deferred.
      if (objectWritten && !isImageMasterKey(objectWritten)) {
        // A lost commit acknowledgement must not delete an already registered image.
        const registered = await db.select({ url: userAssets.url }).from(userAssets).where(eq(userAssets.id, id)).limit(1).catch(() => null);
        if (registered && registered[0]?.url !== objectWritten) await deleteObject(objectWritten).catch(() => {});
      }
      if (error instanceof DanbooruError) throw error;
      throw new DanbooruError('IMPORT_FAILED', 'The image could not be saved. Try again later.', 503);
    }
  },
});
