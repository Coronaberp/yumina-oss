import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { buildGreenScreenPrompt, removeGreenBackground } from "./green-screen.js";

test("green removal yields transparent PNG and keeps enclosed green character details and dimensions", async () => {
  const width = 7, height = 9, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const subject = x >= 2 && x <= 4 && y >= 2 && y <= 6;
    pixels[offset] = subject ? 220 : 0; pixels[offset + 1] = subject ? 30 : 255;
    pixels[offset + 2] = subject ? 30 : 0; pixels[offset + 3] = 255;
  }
  // A green detail enclosed in the subject must survive background removal.
  const detail = (4 * width + 3) * 4;
  pixels[detail] = 0; pixels[detail + 1] = 255; pixels[detail + 2] = 0;
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const result = await removeGreenBackground(png);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, "png"); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  const decoded = await sharp(result).ensureAlpha().raw().toBuffer();
  assert.equal(decoded[3], 0);
  assert.equal(decoded[detail + 1], 255); assert.equal(decoded[detail + 3], 255);
  const body = (2 * width + 2) * 4;
  assert.deepEqual(decoded.subarray(body, body + 4), pixels.subarray(body, body + 4));
});

test("missing green and canceled processing fail rather than saving an opaque sprite", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(removeGreenBackground(png), /No green background/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(removeGreenBackground(png, controller.signal), { name: "AbortError" });
  assert.match(buildGreenScreenPrompt("1girl, silver_hair"), /1girl, silver_hair.*#00FF00/);
});
