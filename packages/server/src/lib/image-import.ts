import sharp from "sharp";
import { allowedEndpointHostname } from "./image-generation/endpoint-policy.js";
import { isAnimatedPng } from "./image-optimization.js";
import { imageContainerFrames } from "./image-container.js";

export class ImageImportPolicyError extends Error {}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
export type ImportedImage = { bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; animated: boolean };

export async function readImportBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!stream) throw Error("Missing image data.");
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error("Image request exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function validateImageImportUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw Error("Enter a valid public image URL.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw Error("Enter a valid public image URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.port ||
    !allowedEndpointHostname(url.hostname, { allowPrivate: false })) throw Error("Use a public HTTP(S) image URL without credentials or a custom port.");
  return url.href;
}

/** Validate bounded inert raster input without rewriting original bytes. The
 * response is always image MIME + nosniff + sandbox; active formats stay denied. */
export async function normalizeImportedImage(bytes: Buffer): Promise<ImportedImage> {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw Error("Images must be between 1 byte and 20 MB.");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const gif = ["GIF87a", "GIF89a"].includes(bytes.toString("ascii",0,6));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP";
  if (!(png || gif || jpeg || webp)) throw Error("Use a PNG, JPEG, GIF or WebP image.");
  if (png && isAnimatedPng(bytes)) throw new ImageImportPolicyError("Animated PNG imports are not supported here. Upload the original file directly to preserve every frame.");
  const containerFrames = imageContainerFrames(bytes, png ? "png" : gif ? "gif" : jpeg ? "jpeg" : "webp");
  try {
    const image = sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS, failOn: "warning" }).timeout({ seconds: 10 });
    const meta = await image.metadata();
    const pages = Math.max(meta.pages ?? 1, containerFrames);
    if (!["png", "jpeg", "gif", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height ||
      pages > 500 || meta.width * (meta.pageHeight ?? meta.height) * pages > MAX_PIXELS) throw Error("Image dimensions exceed the limit.");
    // Force a bounded decode, then retain the complete original file, including
    // color profiles, comments, frame composition, timing and loop metadata.
    await image.stats();
    const mimeType = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}` as ImportedImage["mimeType"];
    return { bytes, mimeType, animated: pages > 1 };
  } catch {
    throw Error("The image is invalid or exceeds the image size/dimension limits.");
  }
}

/** The caller supplies the public-only, DNS-pinned fetcher. Never substitute a redirect-following fetch. */
export async function downloadImportedImage(raw: unknown, signal: AbortSignal, fetcher: typeof fetch): Promise<ImportedImage> {
  const url = validateImageImportUrl(raw);
  const response = await fetcher(url, { method: "GET", signal, redirect: "error", credentials: "omit",
    headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" } });
  const cancel = () => response.body?.cancel().catch(() => {});
  const mime = response.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime ?? "") ||
    ![null,"identity"].includes(response.headers.get("content-encoding")) ||
    Number(response.headers.get("content-length")) > MAX_IMPORT_BYTES || !response.body) {
    await cancel(); throw Error("The link must return a direct PNG, JPEG, GIF or WebP image under 20 MB.");
  }
  return normalizeImportedImage(await readImportBody(response.body, MAX_IMPORT_BYTES, signal));
}
