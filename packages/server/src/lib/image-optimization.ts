export interface UploadedImage {
  key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface ImageStorage {
  read(key: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ buffer: Buffer; contentType: string }>;
  write(key: string, bytes: Buffer, contentType: string, options: { signal: AbortSignal }): Promise<void>;
}

/** Existing references still use this legacy key; never create a new variant. */
export function losslessWebpKey(key: string): string {
  return `${key}.lossless.webp`;
}

// libvips can read an APNG's first frame as a still PNG. Inspect real chunk
// boundaries before decoding so an animation never silently loses its frames.
export function isAnimatedPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return true; // Inconclusive: preserve the original.
    offset = end;
  }
  return true;
}


/** @deprecated Compatibility passthrough only. Masters must retain complete
 * original files through the verified image-master service. Do not transcode,
 * resize, read alternate legacy objects or mutate storage in this wrapper. */
export async function optimizeUploadedImage(asset: UploadedImage, _storage: ImageStorage): Promise<UploadedImage> {
  return asset;
}
