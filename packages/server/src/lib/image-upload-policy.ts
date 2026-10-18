import { setTimeout as wait } from "node:timers/promises";
import sharp from "sharp";
import { HTTPException } from "hono/http-exception";

export const IMAGE_INPUT_LIMIT = 20 * 1024 * 1024;
export const IMAGE_OUTPUT_LIMIT = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_FRAMES = 120;
let active = 0;

// libvips reads APNG as a still PNG. Refuse it rather than silently removing animation.
function isAnimatedPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (offset + length + 12 > input.length) return false;
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") break;
    offset += length + 12;
  }
  return false;
}

export function imageUploadError(message: string, status: 400 | 413 | 503 = 400): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: message, ...(status === 503 ? { code: "IMAGE_PROCESSOR_BUSY" } : {}) }, { status, headers: status === 503 ? { "Retry-After": "3" } : {} }),
  });
}

export function validateImageUploadSize(size: unknown): number {
  if (!Number.isSafeInteger(size) || (size as number) < 1) return imageUploadError("A valid image file size is required. Refresh and try again.");
  if ((size as number) > IMAGE_INPUT_LIMIT) return imageUploadError("Image too large (max 20 MB).", 413);
  return size as number;
}

/** Preserve format, transparency, animation timing and loop. No unsafe original fallback. */
export async function prepareUploadedImage(input: Buffer, mimeType: string) {
  validateImageUploadSize(input.length);
  if (active >= 2) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
  active++;
  try {
    if (isAnimatedPng(input)) return imageUploadError("For animated images, use GIF or animated WebP.");
    const options = { animated: true, limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" as const };
    const image = sharp(input, options);
    const meta = await image.metadata();
    const mimes: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    if (!meta.format || mimes[meta.format] !== mimeType || !meta.width || !meta.height) return imageUploadError("Invalid image or image format does not match the upload.");
    const pages = meta.pages ?? 1;
    const height = meta.pageHeight ?? meta.height;
    if (pages > MAX_FRAMES || meta.width * height * pages > MAX_INPUT_PIXELS) return imageUploadError("Animation is too complex. Use at most 120 frames and 40 megapixels across all frames.", 413);
    if (pages > 1 && (meta.delay ?? []).reduce((sum, delay) => sum + Math.max(20, delay), 0) > 15_000) return imageUploadError("Animated images must be 15 seconds or shorter.", 413);
    const rotated = pages === 1 && [5, 6, 7, 8].includes(meta.orientation ?? 1);
    const width = rotated ? height : meta.width;
    const orientedHeight = rotated ? meta.width : height;
    const landscape = width >= orientedHeight;
    // Rotation of multi-page images is unsupported by libvips. Keep their timing intact.
    const resized = (pages === 1 ? image.rotate() : image)
      .resize(landscape ? 1920 : 1080, landscape ? 1080 : 1920, { fit: "inside", withoutEnlargement: true })
      .timeout({ seconds: 15 });
    let output: Buffer;
    switch (meta.format) {
      case "png": output = await resized.png({ compressionLevel: 9 }).toBuffer(); break;
      case "webp": output = await resized.webp({ quality: 82, effort: 3, loop: meta.loop, delay: meta.delay }).toBuffer(); break;
      case "gif": output = await resized.gif({ effort: 3, loop: meta.loop, delay: meta.delay }).toBuffer(); break;
      default: output = await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
    if (output.length > IMAGE_OUTPUT_LIMIT) return imageUploadError("Optimized image exceeds 5 MB. Reduce image detail or animation length.", 413);
    return { buffer: output, contentType: mimeType, sizeBytes: output.length, animated: pages > 1 };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return imageUploadError("Image could not be processed. Use a valid JPEG, PNG, WebP or GIF within the image limits.");
  } finally { active--; }
}


/** Archive workers share decoder capacity with direct uploads; wait within a bounded budget. */
export async function prepareImportedImage(input: Buffer, mimeType: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await prepareUploadedImage(input, mimeType); }
    catch (error) {
      if (!(error instanceof HTTPException) || error.status !== 503 || attempt >= 10) throw error;
      await wait(3000, undefined, { signal });
    }
  }
}
