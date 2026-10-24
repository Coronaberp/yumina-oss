/** @deprecated Compatibility no-op. Original image masters must never be
 * resized or re-encoded in place. Create an explicit display derivative under
 * a separate key, and use the verified image-master service for originals. */
export function resizeUploadedImageInBackground(
  _key: string,
  _mimeType: string,
  _assetId?: string,
): void {
  // Retain the old call signature without scheduling storage or decoder work.
}
