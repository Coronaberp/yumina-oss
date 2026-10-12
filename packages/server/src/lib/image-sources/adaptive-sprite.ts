import sharp from "sharp";
import { GenerationError } from "../image-generation/config.js";

export type ChromaColor = { name: string; hex: string; saturation: number; deltaEFromPalette: number };
export type SpriteQuality = {
  width: number; height: number; foregroundCoverage: number; transparentCorners: boolean;
  residualBackgroundRatio: number; maskDisagreementRatio: number; detachedForegroundRatio: number; interiorChromaPixelsRemoved: number;
  requestedToActualDeltaE: number; actualBackgroundColor: string; backgroundMismatch: boolean;
  reviewRequired: boolean; reviewReasons: string[];
};

const CANDIDATES = [
  { name: "electric magenta", hex: "#ff00ff" }, { name: "lime green", hex: "#00ff00" },
  { name: "cyan", hex: "#00ffff" }, { name: "orange", hex: "#ff7900" },
  { name: "ultramarine", hex: "#174bff" }, { name: "yellow", hex: "#ffff00" },
  { name: "violet", hex: "#8e00ff" }, { name: "hot pink", hex: "#ff286e" },
];

type Lab = [number, number, number];
type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new GenerationError("INVALID_CHROMA_COLOR", "The selected sprite backdrop color is invalid.", 503);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** CIE Lab D65 conversion; Euclidean Lab distance is used for key selection. */
function rgbToLab([r8, g8, b8]: Rgb): Lab {
  const linear = (n: number) => { const value = n / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const r = linear(r8), g = linear(g8), b = linear(b8);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (v: number) => v > 0.008856451679 ? Math.cbrt(v) : 7.787037037 * v + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a: Lab, b: Lab) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function saturation([r, g, b]: Rgb) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}
function median(values: number[]) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}
function smoothstep(low: number, high: number, value: number) {
  const x = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return x * x * (3 - 2 * x);
}
function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
function quantizedColorIndex([r, g, b]: Rgb) { return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); }

async function measureDetachedForeground(alpha: Buffer, width: number, height: number, signal?: AbortSignal) {
  const count = width * height;
  const visited = new Uint8Array(count), stack = new Uint32Array(count), sizes: number[] = [];
  const minimumComponentPixels = Math.max(64, Math.ceil(count * 0.00025));
  let scanned = 0;
  for (let start = 0; start < count; start++) {
    if (visited[start] || alpha[start * 4 + 3]! < 32) continue;
    let top = 0, size = 0;
    stack[top++] = start; visited[start] = 1;
    while (top) {
      const pixel = stack[--top]!; size++;
      const x = pixel % width, y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited[neighbor] || alpha[neighbor * 4 + 3]! < 32) continue;
        visited[neighbor] = 1; stack[top++] = neighbor;
      }
      if (++scanned % 16_384 === 0) { checkAbort(signal); await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    if (size >= minimumComponentPixels) sizes.push(size);
  }
  checkAbort(signal);
  sizes.sort((a, b) => b - a);
  const detachedPixels = sizes.slice(1).reduce((sum, size) => sum + size, 0);
  return detachedPixels / count;
}

/** Precompute perceptually similar canonical character colors for safe key-color protection. */
async function buildIdentityPaletteLookup(imageBytes: Buffer, signal?: AbortSignal): Promise<Uint8Array> {
  const { data, info } = await sharp(imageBytes, { limitInputPixels: 40_000_000, failOn: "warning" })
    .timeout({ seconds: 15 }).rotate().resize(72, 72, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  checkAbort(signal);
  const radius = Math.max(1, Math.round(Math.min(info.width, info.height) * 0.025));
  const borderColors: Rgb[] = [];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (x >= radius && x < info.width - radius && y >= radius && y < info.height - radius) continue;
    const i = (y * info.width + x) * 4;
    if (data[i + 3]! >= 64) borderColors.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  const border = borderColors.length ? rgbToLab([
    Math.round(median(borderColors.map(color => color[0]))),
    Math.round(median(borderColors.map(color => color[1]))),
    Math.round(median(borderColors.map(color => color[2]))),
  ]) : undefined;
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 64) continue;
    const rgb: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
    if (border && deltaE(rgbToLab(rgb), border) < 13) continue;
    const key = quantizedColorIndex(rgb);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const paletteKeys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 512).map(([key]) => key);
  if (!paletteKeys.length) return new Uint8Array(32_768);
  const paletteLabs = paletteKeys.map(key => rgbToLab([(((key >> 10) & 31) << 3) + 4,
    (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4]));
  const lookup = new Uint8Array(32_768);
  const toleranceSquared = 18 * 18;
  for (let key = 0; key < lookup.length; key++) {
    const lab = rgbToLab([(((key >> 10) & 31) << 3) + 4, (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4]);
    for (const color of paletteLabs) {
      const dl = lab[0] - color[0], da = lab[1] - color[1], db = lab[2] - color[2];
      if (dl * dl + da * da + db * db <= toleranceSquared) { lookup[key] = 1; break; }
    }
  }
  checkAbort(signal);
  return lookup;
}

/** Analyze visible character pixels and choose the saturated key furthest from the palette. */
export async function selectAdaptiveChromaColor(referenceBytes?: Buffer, signal?: AbortSignal): Promise<ChromaColor> {
  checkAbort(signal);
  let palette: Lab[] = [];
  if (referenceBytes?.length) {
    try {
      const { data, info } = await sharp(referenceBytes, { limitInputPixels: 40_000_000, failOn: "warning" })
        .timeout({ seconds: 15 }).rotate().resize(72, 72, { fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      checkAbort(signal);
      const border: Rgb[] = [];
      const radius = Math.max(1, Math.round(Math.min(info.width, info.height) * 0.025));
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        if (x >= radius && x < info.width - radius && y >= radius && y < info.height - radius) continue;
        const i = (y * info.width + x) * 4;
        if (data[i + 3]! > 8) border.push([data[i]!, data[i + 1]!, data[i + 2]!]);
      }
      const borderRgb: Rgb | undefined = border.length ? [
        Math.round(median(border.map(pixel => pixel[0]))), Math.round(median(border.map(pixel => pixel[1]))), Math.round(median(border.map(pixel => pixel[2]))),
      ] : undefined;
      const borderLab = borderRgb ? rgbToLab(borderRgb) : undefined;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < 8) continue;
        const rgb: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
        const lab = rgbToLab(rgb);
        // Opaque reference backdrops are not character colors. Transparent sources need no such heuristic.
        if (borderLab && deltaE(lab, borderLab) < 13) continue;
        palette.push(lab);
      }
      // A uniformly colored or already keyed reference still gives useful palette evidence.
      if (!palette.length) for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 8)
        palette.push(rgbToLab([data[i]!, data[i + 1]!, data[i + 2]!]));
    } catch (error) { checkAbort(signal); if (error instanceof GenerationError) throw error; }
  }
  const scored = CANDIDATES.map(candidate => {
    const rgb = parseHex(candidate.hex), lab = rgbToLab(rgb);
    const distance = palette.length ? Math.min(...palette.map(color => deltaE(lab, color))) : 100;
    return { ...candidate, saturation: saturation(rgb), deltaEFromPalette: Math.round(distance * 10) / 10 };
  }).sort((a, b) => b.deltaEFromPalette - a.deltaEFromPalette || b.saturation - a.saturation);
  return scored[0]!;
}

export async function extractAdaptiveTransparentSprite(
  imageBytes: Buffer, segmentationMaskBytes: Buffer,
  chroma: { color: string; refinedForegroundBytes?: Buffer; identityReferenceBytes?: Buffer }, signal?: AbortSignal,
): Promise<{ bytes: Buffer; quality: SpriteQuality }> {
  checkAbort(signal);
  if (!imageBytes.length || imageBytes.length > 20 * 1024 * 1024 || !segmentationMaskBytes.length || segmentationMaskBytes.length > 20 * 1024 * 1024)
    throw new GenerationError("SPRITE_PROCESSING_FAILED", "The generated sprite or segmentation mask is empty or too large.", 503);
  if (chroma.refinedForegroundBytes && (!chroma.refinedForegroundBytes.length || chroma.refinedForegroundBytes.length > 20 * 1024 * 1024))
    throw new GenerationError("SPRITE_PROCESSING_FAILED", "The refined foreground image is empty or too large.", 503);
  if (chroma.identityReferenceBytes && (!chroma.identityReferenceBytes.length || chroma.identityReferenceBytes.length > 20 * 1024 * 1024))
    throw new GenerationError("SPRITE_PROCESSING_FAILED", "The identity reference image is empty or too large.", 503);
  const requested = parseHex(chroma.color);
  const decoded = await sharp(imageBytes, { limitInputPixels: 40_000_000, failOn: "warning" }).timeout({ seconds: 15 })
    .rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  checkAbort(signal);
  const mask = await sharp(segmentationMaskBytes, { limitInputPixels: 40_000_000, failOn: "warning" }).timeout({ seconds: 15 })
    .rotate().greyscale().raw().toBuffer({ resolveWithObject: true });
  checkAbort(signal);
  const refined = chroma.refinedForegroundBytes ? await sharp(chroma.refinedForegroundBytes, { limitInputPixels: 40_000_000, failOn: "warning" })
    .timeout({ seconds: 15 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }) : undefined;
  checkAbort(signal);
  const identityPalette = chroma.identityReferenceBytes ? await buildIdentityPaletteLookup(chroma.identityReferenceBytes, signal) : undefined;
  const { width, height } = decoded.info;
  if (width < 32 || height < 32 || width * height > 40_000_000 || mask.info.width !== width || mask.info.height !== height)
    throw new GenerationError("SPRITE_PROCESSING_FAILED", "The segmentation mask dimensions do not match the generated sprite.", 503);
  if (refined && (refined.info.width !== width || refined.info.height !== height))
    throw new GenerationError("SPRITE_PROCESSING_FAILED", "The refined foreground dimensions do not match the generated sprite.", 503);

  const pixels = decoded.data;
  const refinedPixels = refined?.data;
  const borderPixels: Rgb[] = [];
  const radius = Math.max(2, Math.min(16, Math.round(Math.min(width, height) * 0.015)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x >= radius && x < width - radius && y >= radius && y < height - radius) continue;
    const i = (y * width + x) * 4;
    if (pixels[i + 3]! > 8) borderPixels.push([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]);
  }
  if (!borderPixels.length) throw new GenerationError("SPRITE_PROCESSING_FAILED", "The generated sprite has no usable backdrop samples.", 503);
  const actual: Rgb = [
    Math.round(median(borderPixels.map(pixel => pixel[0]))),
    Math.round(median(borderPixels.map(pixel => pixel[1]))),
    Math.round(median(borderPixels.map(pixel => pixel[2]))),
  ];
  const requestedLab = rgbToLab(requested), actualLab = rgbToLab(actual);
  const actualToRequested = deltaE(actualLab, requestedLab);
  // Use the observed backdrop for edge decontamination even if the generator ignored
  // the requested hue. BiRefNet still supplies the foreground matte in that case.
  const effectiveBackground = actual;
  const backgroundLab = rgbToLab(effectiveBackground);
  const thresholdLab = rgbToLab(requested);
  const output = Buffer.from(pixels);
  const count = width * height;
  let foreground = 0, interiorChromaPixelsRemoved = 0, residualChroma = 0, maskDisagreement = 0;
  const threshold = Math.min(45, Math.max(34, actualToRequested + 18));

  for (let pixel = 0; pixel < count; pixel++) {
    if (pixel % (width * 128) === 0) { checkAbort(signal); await new Promise<void>(resolve => setImmediate(resolve)); }
    const i = pixel * 4;
    if (output[i + 3] === 0) { output[i + 3] = 0; continue; }
    const sourceRgb: Rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    const lab = rgbToLab(sourceRgb);
    const actualBackgroundDistance = deltaE(lab, backgroundLab);
    const requestedKeyDistance = deltaE(lab, thresholdLab);
    const distance = Math.min(actualBackgroundDistance, requestedKeyDistance);
    const chromaConfidence = 1 - smoothstep(7, threshold, distance);
    const segmentationConfidence = mask.data[pixel]! / 255;
    const paletteMatch = identityPalette?.[quantizedColorIndex(sourceRgb)] === 1;
    // Chroma confidence overrides segmentation for enclosed background pockets. A
    // canonical identity palette protects a key-colored garment only when it matches
    // the requested key, not when the generated backdrop itself drifted into that hue.
    const keyProtection = paletteMatch && requestedKeyDistance <= 15 && actualBackgroundDistance > 18
      && segmentationConfidence >= 0.45 ? 1 : 0;
    const alpha = segmentationConfidence * (1 - chromaConfidence * (1 - keyProtection));
    const alpha8 = Math.max(0, Math.min(255, Math.round(alpha * pixels[i + 3]!)));
    if (alpha8 >= 128) foreground++;
    if (chromaConfidence > 0.85 && alpha8 < 128 && !keyProtection) interiorChromaPixelsRemoved++;
    if (chromaConfidence > 0.85 && segmentationConfidence >= 0.45 && !keyProtection && alpha8 >= 200) residualChroma++;
    if (chromaConfidence > 0.85 && segmentationConfidence >= 0.82 && !keyProtection) maskDisagreement++;

    if (refinedPixels && segmentationConfidence > 0.01) {
      // The installed BiRefNet node has already estimated clean foreground RGB at
      // antialiased boundaries. Keep those pixels while retaining our fused alpha.
      output[i] = refinedPixels[i]!; output[i + 1] = refinedPixels[i + 1]!; output[i + 2] = refinedPixels[i + 2]!;
    } else if (!refinedPixels && alpha > 0.015 && alpha < 0.985 && distance < threshold + 15) {
      // Fallback for segmentation providers that return only a mask.
      for (let channel = 0; channel < 3; channel++) {
        const corrected = (pixels[i + channel]! - (1 - alpha) * effectiveBackground[channel]!) / alpha;
        output[i + channel] = Math.max(0, Math.min(255, Math.round(corrected)));
      }
    }
    output[i + 3] = alpha8;
    if (alpha8 < 2) output[i] = output[i + 1] = output[i + 2] = 0;
  }

  const cornerSize = Math.max(3, Math.min(12, Math.round(Math.min(width, height) * 0.025)));
  const corners: Array<[number, number]> = [[0, 0], [width - cornerSize, 0], [0, height - cornerSize], [width - cornerSize, height - cornerSize]];
  const clearCorner = corners.every(([left, top]) => {
    let total = 0;
    for (let y = top; y < top + cornerSize; y++) for (let x = left; x < left + cornerSize; x++) total += output[(y * width + x) * 4 + 3]!;
    return total / (cornerSize * cornerSize) < 16;
  });
  const detachedForegroundRatio = await measureDetachedForeground(output, width, height, signal);
  const foregroundCoverage = foreground / count;
  const residualBackgroundRatio = residualChroma / count;
  const maskDisagreementRatio = maskDisagreement / count;
  const reviewReasons: string[] = [];
  if (!clearCorner) reviewReasons.push("opaque_outer_corner");
  if (foregroundCoverage < 0.035 || foregroundCoverage > 0.88) reviewReasons.push("implausible_foreground_coverage");
  if (residualBackgroundRatio > 0.002) reviewReasons.push("residual_chroma_color");
  if (detachedForegroundRatio > 0.0015) reviewReasons.push("detached_foreground_artifacts");
  if (!foreground) reviewReasons.push("empty_alpha_matte");
  const bytes = await sharp(output, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  checkAbort(signal);
  return { bytes, quality: { width, height, foregroundCoverage, transparentCorners: clearCorner,
    residualBackgroundRatio, maskDisagreementRatio, detachedForegroundRatio, interiorChromaPixelsRemoved, requestedToActualDeltaE: actualToRequested,
    actualBackgroundColor: `#${actual.map(channel => channel.toString(16).padStart(2, "0")).join("")}`,
    backgroundMismatch: actualToRequested > 45,
    reviewRequired: reviewReasons.length > 0, reviewReasons } };
}

export const rgbToLabForTesting = (rgb: [number, number, number]) => rgbToLab(rgb);
export const deltaEForTesting = (a: Lab, b: Lab) => deltaE(a, b);
