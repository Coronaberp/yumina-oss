import sharp from "sharp";
import { createHash } from "node:crypto";
import { isAnimatedPng } from "./image-optimization.js";
export const MEDIA_INPUT_LIMIT = 16 * 1024 * 1024;
// Full-resolution lossless masters need room comparable to accepted uploads.
export const MEDIA_OUTPUT_LIMIT = 16 * 1024 * 1024;
export const MEDIA_THUMB_LIMIT = 128 * 1024;
export const MEDIA_RESERVATION = MEDIA_OUTPUT_LIMIT + MEDIA_THUMB_LIMIT;
export const MEDIA_MIMES = ["image/jpeg", "image/png", "image/webp"];
const MEDIA_PIXEL_LIMIT = 40000000;
const MEDIA_FRAME_LIMIT = 1000;
let active = 0;
/** Bounded, fail-closed decoding. No small-file or busy-server bypass. */
export async function prepareSessionImage(input: Buffer) {
    if (!input.length || input.length > MEDIA_INPUT_LIMIT)
        throw new Error("MEDIA_INVALID_SIZE");
    if (active >= 2)
        throw new Error("MEDIA_PROCESSOR_BUSY");
    active++;
    try {
        const options = { limitInputPixels: MEDIA_PIXEL_LIMIT, failOn: "warning" as const, animated: true };
        const info = await sharp(input, options).metadata();
        // libvips cannot validate every APNG frame. Keep the existing explicit
        // rejection rather than mistake its first-frame metadata for a still.
        if (!["jpeg", "png", "webp"].includes(info.format ?? "") || isAnimatedPng(input)) {
            throw new Error("MEDIA_UNSUPPORTED_IMAGE");
        }
        const pages = info.pages ?? 1, frameHeight = info.pageHeight ?? info.height;
        if (!info.width || !frameHeight || !Number.isSafeInteger(pages) || pages < 1 || pages > MEDIA_FRAME_LIMIT ||
            info.width * frameHeight * pages > MEDIA_PIXEL_LIMIT) throw new Error("MEDIA_UNSUPPORTED_IMAGE");
        if (pages > 1) {
            // Decode all accepted WebP frames within the same aggregate pixel
            // ceiling. The tiny validation output is never stored as the master.
            await sharp(input, options).resize(1, 1, { fit: "fill" }).webp({ effort: 0 })
                .timeout({ seconds: 15 }).toBuffer();
        }
        // Orientation/resize/8-bit conversion belong only to this explicit
        // display derivative. Master bytes retain profiles, metadata and frames.
        const thumb = await sharp(input, { ...options, animated: false }).rotate()
            .resize(320, 320, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 72, effort: 2 }).timeout({ seconds: 5 }).toBuffer();
        if (input.length > MEDIA_OUTPUT_LIMIT || thumb.length > MEDIA_THUMB_LIMIT)
            throw new Error("MEDIA_OUTPUT_TOO_LARGE");
        const swapsAxes = (info.orientation ?? 1) >= 5 && (info.orientation ?? 1) <= 8;
        return { main: input, thumbnail: thumb, width: swapsAxes ? frameHeight : info.width, height: swapsAxes ? info.width : frameHeight,
            mimeType: info.format === "jpeg" ? "image/jpeg" : `image/${info.format}`,
            size: input.length + thumb.length, hash: createHash("sha256").update(input).digest("hex") };
    }
    finally {
        active--;
    }
}
