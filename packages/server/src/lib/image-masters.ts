import { createHash } from "node:crypto";
import { imageMasterSuffix, imageMasterRasterMime } from "./image-master-key.js";
import { db, type DrizzleDB } from "../db/index.js";
import { encodeImageMaster } from "./image-master-envelope.js";
import { createImageMasterService, ImageMasterError, isImageMasterKey, type ImageMasterAccess } from "./image-master-service.js";
import { getObject, getObjectBuffer, headObject, putObject, copyObject, storageKind } from "./s3.js";
export { ImageMasterError, isImageMasterKey, validSourceSha256 } from "./image-master-service.js";
export const imageMasters = createImageMasterService(db, { encode: encodeImageMaster, write: putObject });
const BUFFERED_INPUT = 32 * 1024 * 1024;
const RASTER_UPLOAD_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** No unbounded Buffer for large originals: hash/copy/verify as streams, with raw
 * storage fallback. This is an optimization budget, never a new upload limit. */
async function hashStoredObject(key: string, expectedSize: number) {
  const object = await getObject(key, { signal: AbortSignal.timeout(60_000) });
  if (!object.body || object.contentEncoding) throw new ImageMasterError("Unsupported staging image encoding");
  const hash = createHash("sha256"); let size = 0, headerBytes = 0;
  const header: Buffer[] = [];
  const body = object.body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > expectedSize) throw new ImageMasterError("Uploaded image changed during registration", 409);
      hash.update(chunk);
      if (headerBytes < 64 * 1024) { const part = Buffer.from(chunk.subarray(0, 64 * 1024 - headerBytes)); header.push(part); headerBytes += part.length; }
    }
  } finally { body.destroy?.(); }
  if (size !== expectedSize) throw new ImageMasterError("Uploaded image changed during registration", 409);
  const prefix = Buffer.concat(header, headerBytes);
  return { hash: hash.digest("hex"), suffix: imageMasterSuffix(prefix, expectedSize <= headerBytes), mimeType: imageMasterRasterMime(prefix) };
}
export async function storeUploadedImage(input: { userId: string; key: string; mimeType?: string; sourceSha256?: string; access?: ImageMasterAccess }, tx?: Pick<DrizzleDB, "execute">) {
  const access = input.access ?? "public";
  if (isImageMasterKey(input.key)) {
    const master = await imageMasters.findByKey(input.userId, access, input.key, tx);
    if (!master || (input.sourceSha256 && input.sourceSha256.toLowerCase() !== master.sourceSha256) || (input.mimeType && input.mimeType !== master.mimeType && !(access === "public" && RASTER_UPLOAD_MIMES.includes(input.mimeType) && input.sourceSha256?.toLowerCase() === master.sourceSha256))) throw new ImageMasterError("Image master not found or does not match this upload", 404);
    return master;
  }
  const verified = await imageMasters.findUpload(input.userId, access, input.key, tx);
  if (verified) {
    if ((input.sourceSha256 && input.sourceSha256.toLowerCase() !== verified.sourceSha256) || (input.mimeType && input.mimeType !== verified.mimeType && !(access === "public" && RASTER_UPLOAD_MIMES.includes(input.mimeType) && input.sourceSha256?.toLowerCase() === verified.sourceSha256))) throw new ImageMasterError("Image upload conflicts with previously verified bytes", 409);
    return verified;
  }
  const inspected = await headObject(input.key);
  if (inspected.contentEncoding || inspected.contentLength < 1 || inspected.contentLength > 2_147_483_647) throw new ImageMasterError("Invalid uploaded image");
  const declaredMime = inspected.contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!RASTER_UPLOAD_MIMES.includes(declaredMime) || (input.mimeType && !RASTER_UPLOAD_MIMES.includes(input.mimeType))) throw new ImageMasterError("Uploaded image content type does not match", 409);
  if (inspected.contentLength <= BUFFERED_INPUT) {
    const { buffer } = await getObjectBuffer(input.key, { maxBytes: BUFFERED_INPUT, signal: AbortSignal.timeout(60_000) });
    if (buffer.length !== inspected.contentLength) throw new ImageMasterError("Uploaded image changed during registration", 409);
    const mimeType = imageMasterRasterMime(buffer) ?? declaredMime;
    if (access === "private" && (mimeType !== declaredMime || (input.mimeType && input.mimeType !== mimeType))) throw new ImageMasterError("Uploaded image content type does not match", 409);
    const master = await imageMasters.store({ userId: input.userId, access, bytes: buffer, mimeType, sourceSha256: input.sourceSha256 }, tx);
    await imageMasters.rememberUpload(input.userId, access, input.key, master.sourceSha256, tx);
    return master;
  }
  const { hash: sourceSha256, suffix, mimeType: detectedMime } = await hashStoredObject(input.key, inspected.contentLength);
  const mimeType = detectedMime ?? declaredMime;
  if (access === "private" && (mimeType !== declaredMime || (input.mimeType && input.mimeType !== mimeType))) throw new ImageMasterError("Uploaded image content type does not match", 409);
  if (input.sourceSha256 && input.sourceSha256.toLowerCase() !== sourceSha256) throw new ImageMasterError("Image source hash does not match uploaded bytes", 409);
  const master = await imageMasters.storeVerifiedOriginal({ userId: input.userId, access, sourceSha256, originalSize: inspected.contentLength, mimeType, suffix,
    install: async key => {
      const metadata = { ...inspected, contentType: mimeType };
      if (storageKind() === "s3" && inspected.etag) await copyObject(input.key, key, inspected.etag, metadata);
      else await copyObject(input.key, key, undefined, metadata);
      if ((await hashStoredObject(key, inspected.contentLength)).hash !== sourceSha256) throw new ImageMasterError("Uploaded image changed during registration", 409);
    },
  }, tx);
  await imageMasters.rememberUpload(input.userId, access, input.key, master.sourceSha256, tx);
  return master;
}
