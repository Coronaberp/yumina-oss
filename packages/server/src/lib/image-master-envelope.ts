import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";

// Budget, not an upload limit: original + bounded chunks + their concatenation
// use at most 24 MiB, leaving room for codec state and stream buffers below 32 MiB.
export const IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES = 8 * 1024 * 1024;
let compressing = false;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;

export interface ImageMasterMetadata {
  contentType: string;
  contentEncoding?: string;
  decodedLength?: number;
  sourceSha256?: string;
  storedSha256?: string;
}
export type ImageMasterWriteOptions = Omit<ImageMasterMetadata, "contentType"> & { signal?: AbortSignal };
export interface EncodedImageMaster {
  bytes: Buffer;
  sourceSha256: string;
  storedSha256: string;
  originalSize: number;
  storedSize: number;
  contentEncoding?: "gzip";
}

/** Only new opt-in image masters decode; legacy gzip packs remain raw. */
export function isImageMasterEnvelope(metadata: ImageMasterMetadata): boolean {
  return metadata.contentType.toLowerCase().split(";", 1)[0]!.trim().startsWith("image/")
    && metadata.contentEncoding?.toLowerCase() === "gzip" && metadata.sourceSha256 !== undefined;
}

export function imageMasterDecodedLength(metadata: ImageMasterMetadata, maxBytes = IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES): number {
  const size = metadata.decodedLength;
  if (!hashPattern.test(metadata.sourceSha256 ?? "") || !hashPattern.test(metadata.storedSha256 ?? "")
    || !Number.isSafeInteger(size) || !size || size < 0) throw new Error("Invalid image master envelope metadata");
  if (size > IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES || size > maxBytes) throw new Error("Image master exceeds decoded byte limit");
  return size;
}

/** Complete original bytes, independent of format, pixels, metadata or frames. */
export async function encodeImageMaster(input: Buffer, options?: { signal?: AbortSignal }): Promise<EncodedImageMaster> {
  options?.signal?.throwIfAborted();
  const sourceSha256 = sha256(input);
  const raw: EncodedImageMaster = { bytes: input, sourceSha256, storedSha256: sourceSha256, originalSize: input.length, storedSize: input.length };
  if (!input.length || input.length > IMAGE_MASTER_OPTIMIZATION_INPUT_BYTES || compressing) return raw;
  compressing = true;
  try {
    const chunks: Buffer[] = []; let size = 0;
    const notSmaller = new Error("Image compression saves less than one percent");
    // Already-compressed rasters rarely gain much; prefer lower CPU effort.
    // A conservative prefix probe can miss savings found only in later bytes.
    if (input.length > 64 * 1024) {
      const prefix = input.subarray(0, 64 * 1024); let prefixSize = 0;
      await pipeline(Readable.from([prefix]), createGzip({ level: 1 }), new Writable({
        write(chunk: Buffer, _encoding, done) {
          prefixSize += chunk.length;
          done(prefixSize * 100 > prefix.length * 99 ? notSmaller : undefined);
        },
      }), { signal: options?.signal });
    }
    await pipeline(Readable.from([input]), createGzip({ level: 1 }), new Writable({
      write(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size * 100 > input.length * 99) return done(notSmaller);
        chunks.push(chunk); done();
      },
    }), { signal: options?.signal });
    const bytes = Buffer.concat(chunks, size);
    // Compare every recovered byte directly, without allocating a decoded copy.
    let offset = 0;
    await pipeline(Readable.from([bytes]), createGunzip(), new Writable({
      write(chunk: Buffer, _encoding, done) {
        if (offset + chunk.length > input.length || !input.subarray(offset, offset + chunk.length).equals(chunk))
          return done(new Error("Image compression verification failed"));
        offset += chunk.length; done();
      },
    }), { signal: options?.signal });
    if (offset !== input.length) return raw;
    options?.signal?.throwIfAborted();
    return { bytes, sourceSha256, storedSha256: sha256(bytes), originalSize: input.length, storedSize: bytes.length, contentEncoding: "gzip" };
  } catch {
    options?.signal?.throwIfAborted();
    return raw;
  } finally { compressing = false; }
}

/** Decode only complete verified envelopes, enforcing limits during inflation. */
export async function decodeImageMaster(bytes: Buffer, metadata: ImageMasterMetadata, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<Buffer> {
  options?.signal?.throwIfAborted();
  if (!isImageMasterEnvelope(metadata)) return bytes;
  const size = imageMasterDecodedLength(metadata, options?.maxBytes);
  if (bytes.length >= size || sha256(bytes) !== metadata.storedSha256) throw new Error("Invalid image master stored bytes");
  const chunks: Buffer[] = []; let decoded = 0; const hash = createHash("sha256");
  try {
    await pipeline(Readable.from([bytes]), createGunzip(), new Writable({
      write(chunk: Buffer, _encoding, done) {
        decoded += chunk.length;
        if (decoded > size) return done(new Error("Image master exceeds decoded byte limit"));
        hash.update(chunk); chunks.push(chunk); done();
      },
    }), { signal: options?.signal });
    if (decoded !== size || hash.digest("hex") !== metadata.sourceSha256) throw new Error("Invalid image master decoded bytes");
    return Buffer.concat(chunks, decoded);
  } catch (error) {
    options?.signal?.throwIfAborted();
    if (error instanceof Error && /image master/i.test(error.message)) throw error;
    throw new Error("Invalid image master gzip data", { cause: error });
  }
}
