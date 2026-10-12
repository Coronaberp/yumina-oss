import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

const api = await import("./adaptive-sprite.js").catch(() => ({} as typeof import("./adaptive-sprite.js")));

test("adaptive chroma selects a saturated hue perceptually far from visible reference colors", async () => {
  const pixels = Buffer.alloc(40 * 40 * 4);
  for (let i = 0; i < 40 * 40; i++) pixels.set([218, 32, 42, 255], i * 4);
  const reference = await sharp(pixels, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
  const selected = await api.selectAdaptiveChromaColor(reference);
  assert.match(selected.hex, /^#[0-9a-f]{6}$/i);
  assert.ok(selected.saturation >= 0.65);
  assert.ok(selected.deltaEFromPalette >= 35);
});

test("hybrid key fusion removes enclosed chroma pockets, preserves matching foreground, and softens edges", async () => {
  const width = 64, height = 64;
  const background = { r: 202, g: 122, b: 202 };
  const keyDetail = { r: 255, g: 0, b: 220 };
  const image = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height);
  const put = (x: number, y: number, rgba: [number, number, number, number], confidence: number) => {
    const p = y * width + x;
    image.set(rgba, p * 4);
    mask[p] = confidence;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, [background.r, background.g, background.b, 255], 0);
  // Character silhouette, with a chroma-colored detail explicitly identified as foreground.
  for (let y = 8; y < 58; y++) for (let x = 16; x < 48; x++) {
    const gap = (x >= 29 && x <= 34 && y >= 26 && y <= 40);
    if (gap) continue;
    put(x, y, [80, 35, 120, 255], 255);
  }
  put(24, 20, [keyDetail.r, keyDetail.g, keyDetail.b, 255], 255);
  // A mixed edge pixel tests alpha recovery and chroma decontamination.
  put(15, 22, [150, 90, 150, 255], 128);
  const original = await sharp(image, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const matte = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const result = await api.extractAdaptiveTransparentSprite(original, matte, { color: "#ff00dc" });
  const pixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]!;
  assert.ok(alpha(2, 2) < 8, "outer corner is transparent");
  assert.ok(alpha(31, 32) < 24, "an enclosed arm/torso gap is transparent");
  assert.ok(alpha(24, 20) < 24, "chroma wins over a mistaken foreground mask without canonical palette evidence");
  assert.ok(alpha(15, 22) > 20 && alpha(15, 22) < 240, "edge keeps a soft alpha matte");
  assert.ok(result.quality.transparentCorners);
  assert.ok(result.quality.foregroundCoverage > 0.1 && result.quality.foregroundCoverage < 0.9);
  const identityPixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) identityPixels.set([80, 35, 120, 255], i * 4);
  identityPixels.set([keyDetail.r, keyDetail.g, keyDetail.b, 255], (20 * width + 24) * 4);
  const identityReference = await sharp(identityPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const protectedResult = await api.extractAdaptiveTransparentSprite(original, matte,
    { color: "#ff00dc", identityReferenceBytes: identityReference });
  const protectedPixels = await sharp(protectedResult.bytes).ensureAlpha().raw().toBuffer();
  assert.ok(protectedPixels[(20 * width + 24) * 4 + 3]! > 245,
    "a key-colored character detail is protected when it appears in the canonical identity palette");
  const refinedPixels = Buffer.from(image);
  refinedPixels.set([76, 34, 120, 255], (22 * width + 15) * 4);
  const refined = await sharp(refinedPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const refinedResult = await api.extractAdaptiveTransparentSprite(original, matte,
    { color: "#ff00dc", refinedForegroundBytes: refined });
  const refinedOutput = await sharp(refinedResult.bytes).ensureAlpha().raw().toBuffer();
  const edge = (22 * width + 15) * 4;
  assert.deepEqual([...refinedOutput.subarray(edge, edge + 3)], [76, 34, 120], "BiRefNet's foreground color refinement survives the fused alpha step");
});

test("quality validation marks an empty extraction for review", async () => {
  const width = 64, height = 64;
  const original = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toBuffer();
  const mask = await sharp(Buffer.alloc(width * height, 255), { raw: { width, height, channels: 1 } }).png().toBuffer();
  const result = await api.extractAdaptiveTransparentSprite(original, mask, { color: "#00ff00" });
  assert.equal(result.quality.reviewRequired, true);
  assert.equal(result.quality.transparentCorners, true);
  assert.ok(result.quality.reviewReasons.includes("empty_alpha_matte"));
});

test("a different generated backdrop is measured and removed without blocking a clean segmentation", async () => {
  const width = 64, height = 64;
  const image = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel++) image.set([255, 255, 255, 255], pixel * 4);
  for (let y = 8; y < 58; y++) for (let x = 16; x < 48; x++) {
    const pixel = y * width + x;
    image.set([80, 45, 120, 255], pixel * 4);
    mask[pixel] = 255;
  }
  const original = await sharp(image, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const matte = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const result = await api.extractAdaptiveTransparentSprite(original, matte, { color: "#ff00ff" });
  assert.equal(result.quality.backgroundMismatch, true);
  assert.equal(result.quality.actualBackgroundColor, "#ffffff");
  assert.equal(result.quality.reviewRequired, false);
  const pixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(pixels[3], 0, "the observed white backdrop is removed from the corners");
  assert.equal(pixels[(32 * width + 32) * 4 + 3], 255, "the segmented character remains opaque");
});

test("a disconnected backdrop-colored pocket is removed even when BiRefNet calls it foreground", async () => {
  const width = 64, height = 64;
  const image = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height, 0);
  for (let pixel = 0; pixel < width * height; pixel++) image.set([202, 122, 202, 255], pixel * 4);
  for (let y = 8; y < 58; y++) for (let x = 12; x < 52; x++) {
    const pixel = y * width + x;
    image.set([90, 40, 120, 255], pixel * 4);
    mask[pixel] = 255;
  }
  // BiRefNet's false-positive segment fills the enclosed gap between the arms and torso.
  for (let y = 25; y < 42; y++) for (let x = 29; x < 35; x++) {
    const pixel = y * width + x;
    image.set([202, 122, 202, 255], pixel * 4);
    mask[pixel] = 255;
  }
  const original = await sharp(image, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const matte = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const result = await api.extractAdaptiveTransparentSprite(original, matte, { color: "#8e00ff" });
  const pixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  assert.ok(pixels[(32 * width + 32) * 4 + 3]! < 24, "the enclosed backdrop pocket is removed despite a confident segmentation mask");
  assert.ok(result.quality.interiorChromaPixelsRemoved > 0);
});

test("large detached generated fragments require review while small isolated details stay opaque", async () => {
  const width = 128, height = 128;
  const image = Buffer.alloc(width * height * 4), mask = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel++) image.set([202, 122, 202, 255], pixel * 4);
  const put = (x: number, y: number, color: [number, number, number, number]) => {
    const pixel = y * width + x; image.set(color, pixel * 4); mask[pixel] = 255;
  };
  for (let y = 12; y < 112; y++) for (let x = 24; x < 104; x++) put(x, y, [74, 50, 112, 255]);
  for (let y = 20; y < 42; y++) for (let x = 106; x < 128; x++) put(x, y, [220, 50, 80, 255]);
  for (let x = 108; x < 111; x++) put(x, 52, [255, 220, 40, 255]);
  const original = await sharp(image, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const matte = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const result = await api.extractAdaptiveTransparentSprite(original, matte, { color: "#8e00ff" });
  const pixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  assert.ok(result.quality.detachedForegroundRatio > 0.003);
  assert.ok(result.quality.reviewReasons.includes("detached_foreground_artifacts"));
  assert.ok(pixels[(52 * width + 109) * 4 + 3]! > 245, "small isolated accessory pixels are kept intact");
  const smallOnlyMask = Buffer.from(mask);
  for (let y = 20; y < 42; y++) for (let x = 106; x < 128; x++) smallOnlyMask[y * width + x] = 0;
  const smallOnlyMatte = await sharp(smallOnlyMask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const smallOnly = await api.extractAdaptiveTransparentSprite(original, smallOnlyMatte, { color: "#8e00ff" });
  const smallOnlyPixels = await sharp(smallOnly.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(smallOnly.quality.reviewRequired, false, "a few disconnected accessory pixels do not trigger review");
  assert.ok(smallOnlyPixels[(52 * width + 109) * 4 + 3]! > 245);
});
