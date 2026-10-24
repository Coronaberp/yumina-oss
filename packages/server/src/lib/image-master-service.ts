import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { imageMasterSuffix, validImageMasterSuffix, imageMasterDetectedMime } from "./image-master-key.js";
import type { DrizzleDB } from "../db/index.js";

export type ImageMasterAccess = "public" | "private";
export type ImageMaster = { key: string; sourceSha256: string; storedSha256: string; originalSize: number; storedSize: number; mimeType: string; contentEncoding?: "gzip" };
type EncodedMaster = Omit<ImageMaster, "key" | "mimeType"> & { bytes: Buffer };
type Executor = Pick<DrizzleDB, "execute">;
type MasterRow = { object_key: string; source_sha256: string; stored_sha256: string; original_size: string | number; stored_size: string | number; mime_type: string; content_encoding: "gzip" | null };
export class ImageMasterError extends Error { constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); } }
export function validSourceSha256(value: unknown): value is string | undefined { return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)); }
export function isImageMasterKey(key: string): boolean { return /^(?:users|private-session-media)\/[^/]+\/image-masters\/(?:public|private)\/[a-f0-9]{64}(?:\.(?:anim\.)?(?:png|jpg|jpeg|gif|webp|avif|heif|heic|bin))?$/.test(key); }
const inertImageMime = (mime: string) => /^image\/[a-z0-9.+-]+$/i.test(mime) && !["image/svg+xml", "image/svg", "image/xml"].includes(mime.toLowerCase());
const describe = (row: MasterRow): ImageMaster => ({ key: row.object_key, sourceSha256: row.source_sha256, storedSha256: row.stored_sha256, originalSize: Number(row.original_size), storedSize: Number(row.stored_size), mimeType: row.mime_type, ...(row.content_encoding ? { contentEncoding: row.content_encoding } : {}) });

/** Physical reuse is separate from logical asset IDs/names/folders. Registry
 * entries are append-only; no call here deletes shared content or changes ACLs.
 * Content hashes index private registry rows; public storage locators are random
 * and created once under the owner lock, never derived from a known file hash. */
export function createImageMasterService(database: DrizzleDB, storage: {
  encode(bytes: Buffer, options?: { signal?: AbortSignal }): Promise<EncodedMaster>;
  write(key: string, bytes: Buffer, mimeType: string, options: { signal?: AbortSignal; contentEncoding?: "gzip"; decodedLength: number; sourceSha256: string; storedSha256: string }): Promise<void>;
}) {
  async function find(userId: string, access: ImageMasterAccess, hash: string, tx: Executor = database): Promise<ImageMaster | undefined> {
    if (!validSourceSha256(hash) || !hash) throw new ImageMasterError("Invalid image source hash");
    const rows = (await tx.execute(sql`SELECT * FROM image_masters WHERE user_id=${userId} AND access_class=${access} AND source_sha256=${hash.toLowerCase()} LIMIT 1`)).rows as MasterRow[];
    return rows[0] ? describe(rows[0]) : undefined;
  }
  async function findByKey(userId: string, access: ImageMasterAccess, key: string, tx: Executor = database): Promise<ImageMaster | undefined> {
    if (!isImageMasterKey(key)) return;
    const rows = (await tx.execute(sql`SELECT * FROM image_masters WHERE user_id=${userId} AND access_class=${access} AND object_key=${key} LIMIT 1`)).rows as MasterRow[];
    return rows[0] ? describe(rows[0]) : undefined;
  }
  async function findUpload(userId: string, access: ImageMasterAccess, key: string, tx: Executor = database): Promise<ImageMaster | undefined> {
    const rows = (await tx.execute(sql`SELECT m.* FROM image_master_uploads u JOIN image_masters m USING(user_id,access_class,source_sha256)
      WHERE u.user_id=${userId} AND u.access_class=${access} AND u.upload_key=${key} LIMIT 1`)).rows as MasterRow[];
    return rows[0] ? describe(rows[0]) : undefined;
  }
  async function rememberUpload(userId: string, access: ImageMasterAccess, key: string, hash: string, tx: Executor = database) {
    await tx.execute(sql`INSERT INTO image_master_uploads(user_id,access_class,upload_key,source_sha256)
      VALUES(${userId},${access},${key},${hash}) ON CONFLICT(user_id,access_class,upload_key) DO NOTHING`);
    if ((await findUpload(userId, access, key, tx))?.sourceSha256 !== hash) throw new ImageMasterError("Image upload conflicts with previously verified bytes", 409);
  }
  async function store(input: { userId: string; access: ImageMasterAccess; bytes: Buffer; mimeType: string; sourceSha256?: string; signal?: AbortSignal }, executor?: Executor): Promise<ImageMaster> {
    input.signal?.throwIfAborted();
    if (!input.bytes.length || !inertImageMime(input.mimeType) || !validSourceSha256(input.sourceSha256)) throw new ImageMasterError("Invalid image master");
    const detectedMime = imageMasterDetectedMime(input.bytes);
    if (input.access === "private" && detectedMime && detectedMime !== input.mimeType) throw new ImageMasterError("Image content type does not match the private image format", 409);
    const mimeType = detectedMime ?? input.mimeType;
    const sourceSha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (input.sourceSha256 && input.sourceSha256.toLowerCase() !== sourceSha256) throw new ImageMasterError("Image source hash does not match uploaded bytes", 409);
    const create = async (tx: Executor) => {
      const owners = (await tx.execute(sql`SELECT id FROM "user" WHERE id=${input.userId} FOR UPDATE`)).rows;
      if (!owners.length) throw new ImageMasterError("Image owner account not found", 404);
      const existing = await find(input.userId, input.access, sourceSha256, tx);
      if (existing) return existing;
      const encoded = await storage.encode(input.bytes, { signal: input.signal });
      if (encoded.sourceSha256 !== sourceSha256 || encoded.originalSize !== input.bytes.length) throw new ImageMasterError("Image encoder changed source identity", 409);
      const key = `${input.access === "private" ? "private-session-media" : "users"}/${input.userId}/image-masters/${input.access}/${randomBytes(32).toString("hex")}${imageMasterSuffix(input.bytes)}`;
      input.signal?.throwIfAborted();
      await storage.write(key, encoded.bytes, mimeType, { signal: input.signal, contentEncoding: encoded.contentEncoding, decodedLength: encoded.originalSize, sourceSha256, storedSha256: encoded.storedSha256 });
      // On an uncertain DB outcome retain the candidate. Eager rollback deletion
      // could remove a committed/shared master; safe orphan cleanup is deferred.
      await tx.execute(sql`INSERT INTO image_masters(user_id,access_class,source_sha256,object_key,mime_type,original_size,stored_size,stored_sha256,content_encoding)
        VALUES(${input.userId},${input.access},${sourceSha256},${key},${mimeType},${encoded.originalSize},${encoded.storedSize},${encoded.storedSha256},${encoded.contentEncoding ?? null}) ON CONFLICT(user_id,access_class,source_sha256) DO NOTHING`);
      return (await find(input.userId, input.access, sourceSha256, tx))!;
    };
    return executor ? create(executor) : database.transaction(create);
  }
  /** Internal large-file path: caller must copy AND stream-verify immutable bytes
   * inside install. The canonical key is never exposed as a writable upload. */
  async function storeVerifiedOriginal(input: { userId: string; access: ImageMasterAccess; sourceSha256: string; originalSize: number; mimeType: string; suffix?: string; install(key: string): Promise<void> }, executor?: Executor): Promise<ImageMaster> {
    if (!inertImageMime(input.mimeType) || !validSourceSha256(input.sourceSha256) || !input.sourceSha256 || !Number.isSafeInteger(input.originalSize) || input.originalSize < 1) throw new ImageMasterError("Invalid image master");
    const create = async (tx: Executor) => {
      const owners = (await tx.execute(sql`SELECT id FROM "user" WHERE id=${input.userId} FOR UPDATE`)).rows;
      if (!owners.length) throw new ImageMasterError("Image owner account not found", 404);
      const existing = await find(input.userId, input.access, input.sourceSha256, tx);
      if (existing) return existing;
      const suffix = input.suffix ?? ".bin";
      if (!validImageMasterSuffix(suffix)) throw new ImageMasterError("Invalid image master format hint");
      const key = `${input.access === "private" ? "private-session-media" : "users"}/${input.userId}/image-masters/${input.access}/${randomBytes(32).toString("hex")}${suffix}`;
      await input.install(key);
      await tx.execute(sql`INSERT INTO image_masters(user_id,access_class,source_sha256,object_key,mime_type,original_size,stored_size,stored_sha256)
        VALUES(${input.userId},${input.access},${input.sourceSha256},${key},${input.mimeType},${input.originalSize},${input.originalSize},${input.sourceSha256}) ON CONFLICT(user_id,access_class,source_sha256) DO NOTHING`);
      return (await find(input.userId, input.access, input.sourceSha256, tx))!;
    };
    return executor ? create(executor) : database.transaction(create);
  }
  return { find, findByKey, findUpload, rememberUpload, store, storeVerifiedOriginal };
}
