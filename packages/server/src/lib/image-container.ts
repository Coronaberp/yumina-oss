/** Prove accepted raster containers end at their declared terminator before
 * retaining raw URL/paste bytes. Metadata inside valid chunks stays untouched;
 * extra bytes outside the container are rejected instead of silently stripped. */
export function imageContainerFrames(bytes: Buffer, format: "png" | "jpeg" | "gif" | "webp"): number {
  const invalid = () => { throw new Error("The image container is incomplete or contains unsupported trailing data."); };
  if (format === "png") {
    let frames = 1;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) return invalid();
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      // APNG requires complete secondary-frame validation that this raster
      // import decoder cannot provide. Reject even malformed/late controls.
      if (type === "acTL" || type === "fcTL" || type === "fdAT") return invalid();
      if (type === "IEND") { if (length !== 0 || end !== bytes.length) return invalid(); return frames; }
      offset = end;
    }
    return invalid();
  }
  if (format === "webp") {
    if (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== bytes.length) return invalid();
    let offset = 12;
    while (offset + 8 <= bytes.length) { const length = bytes.readUInt32LE(offset + 4); offset += 8 + length + (length & 1); }
    if (offset !== bytes.length) return invalid();
    return 1;
  }
  if (format === "gif") {
    if (bytes.length < 13) return invalid();
    let offset = 13 + ((bytes[10]! & 0x80) ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0), frames = 0;
    const blocks = () => {
      for (;;) { if (offset >= bytes.length) return invalid(); const length = bytes[offset++]!; if (!length) return; offset += length; if (offset > bytes.length) return invalid(); }
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++]!;
      if (marker === 0x3b) { if (offset !== bytes.length || !frames) return invalid(); return frames; }
      if (marker === 0x21) { offset++; blocks(); continue; }
      if (marker !== 0x2c || offset + 9 > bytes.length) return invalid();
      frames++; const packed = bytes[offset + 8]!; offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      offset++; blocks();
    }
    return invalid();
  }
  // JPEG segments can contain complete embedded thumbnails in EXIF; skip their
  // declared lengths rather than finding an arbitrary FF D9 inside metadata.
  let offset = 2, entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      let found = false;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        const markerOffset = offset - 1;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset];
        if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) { offset++; continue; }
        offset = markerOffset; entropy = false; found = true; break;
      }
      if (!found) return invalid();
    }
    if (bytes[offset++] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (offset !== bytes.length) return invalid(); return 1; }
    if (marker === undefined || marker === 0 || marker === 0xd8) return invalid();
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return invalid();
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) return invalid();
    offset += length; entropy = marker === 0xda;
  }
  return invalid();
}
