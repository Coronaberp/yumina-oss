import sharp from "sharp";

/** ComfyUI accepts the creator's tag prompt; the key color is fixed by the sprite pipeline. */
export function buildGreenScreenPrompt(prompt: string): string {
  return `${prompt.trim()}, solo, character sprite, isolated character, simple_background, green_background, chroma_key, flat solid bright green background (#00FF00), no background objects, no shadows on background, no green clothing or accessories, entire character inside frame`;
}

let activeRemovals = 0;
/** Remove edge-connected green background, retaining enclosed green details on the character. */
export async function removeGreenBackground(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Sprite images must be at most 20 MB.");
  if (activeRemovals >= 2) throw new Error("Sprite processing is busy. Try again shortly.");
  activeRemovals++;
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" })
      .timeout({ seconds: 15 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    signal?.throwIfAborted();
    const { width, height } = info;
    const count = width * height;
    const mask = new Uint8Array(count), queue = new Int32Array(count);
    let head = 0, tail = 0;
    const enqueue = (pixel: number) => {
      if (mask[pixel]) return;
      const offset = pixel * 4;
      const red = data[offset]!, green = data[offset + 1]!, blue = data[offset + 2]!;
      if (data[offset + 3] !== 0 && (green < 70 || green - Math.max(red, blue) < 20)) return;
      mask[pixel] = 1; queue[tail++] = pixel;
    };
    for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
    while (head < tail) {
      const pixel = queue[head++]!, x = pixel % width, y = Math.floor(pixel / width);
      if (x > 0) enqueue(pixel - 1);
      if (x + 1 < width) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - width);
      if (y + 1 < height) enqueue(pixel + width);
      if (head % 1_000_000 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
    }
    let removed = 0;
    for (let pixel = 0; pixel < count; pixel++) {
      if (!mask[pixel]) continue;
      const offset = pixel * 4;
      const dominance = data[offset + 1]! - Math.max(data[offset]!, data[offset + 2]!);
      // Soft alpha on mixed edge pixels reduces a jagged green fringe.
      const alpha = Math.round(data[offset + 3]! * Math.max(0, Math.min(1, (80 - dominance) / 60)));
      if (alpha < data[offset + 3]!) removed++;
      data[offset + 3] = alpha;
      if (!alpha) { data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0; }
      else data[offset + 1] = Math.min(data[offset + 1]!, Math.max(data[offset]!, data[offset + 2]!));
    }
    if (!removed) throw new Error("No green background was found. Use a flat bright green background in the ComfyUI sprite workflow.");
    signal?.throwIfAborted();
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  } finally { activeRemovals--; }
}
