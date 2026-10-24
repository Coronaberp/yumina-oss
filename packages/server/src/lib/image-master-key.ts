const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
/** Header detection never infers identity or MIME from the logical filename. */
export function imageMasterRasterMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  if (bytes.subarray(0,8).equals(PNG)) return "image/png";
  if (["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6))) return "image/gif";
  if (bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return "image/jpeg";
  if (bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP") return "image/webp";
}
function containerBrands(bytes: Buffer): string[] {
  if (bytes.length < 16 || bytes.toString("ascii",4,8) !== "ftyp") return [];
  const end = Math.min(bytes.readUInt32BE(0), bytes.length, 256);
  if (end < 16) return [];
  const brands = [bytes.toString("ascii",8,12)];
  for (let offset=16; offset+4<=end; offset+=4) brands.push(bytes.toString("ascii",offset,offset+4));
  return brands;
}
/** Supported magic only; unknown inert files retain their caller-validated MIME. */
export function imageMasterDetectedMime(bytes: Buffer): string | undefined {
  const raster = imageMasterRasterMime(bytes);
  if (raster) return raster;
  const brands = containerBrands(bytes);
  if (brands.some(brand => brand === "avif" || brand === "avis")) return "image/avif";
  if (brands.some(brand => ["heic","heix","hevc","hevx","mif1","msf1"].includes(brand))) return "image/heif";
}
/** Format and animation hints are source-derived, never inherited from filenames.
 * Incomplete bounded headers conservatively retain motion handling for PNG/WebP. */
export function imageMasterSuffix(bytes: Buffer, complete = true): string {
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii",0,6))) return ".gif";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.subarray(0,8).equals(PNG)) {
    for (let offset=8; offset+12<=bytes.length;) {
      const type=bytes.toString("ascii",offset+4,offset+8),length=bytes.readUInt32BE(offset);
      if(type==="acTL")return ".anim.png";
      if(type==="IDAT"||type==="IEND")return ".png";
      const end=offset+12+length;if(end>bytes.length)return ".anim.png";offset=end;
    }
    return complete ? ".png" : ".anim.png";
  }
  if(bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"){
    for(let offset=12;offset+8<=bytes.length;){
      const type=bytes.toString("ascii",offset,offset+4),length=bytes.readUInt32LE(offset+4);
      if(type==="ANIM"||type==="ANMF")return ".anim.webp";
      if(type==="VP8X"){if(offset+8>=bytes.length)return ".anim.webp";return bytes[offset+8]!&2?".anim.webp":".webp";}
      if(type==="VP8 "||type==="VP8L")return ".webp";
      const end=offset+8+length+(length&1);if(end>bytes.length)return ".anim.webp";offset=end;
    }
    return complete ? ".webp" : ".anim.webp";
  }
  const brands = containerBrands(bytes);
  if(brands.includes("avis"))return ".anim.avif";
  if(brands.includes("avif"))return ".avif";
  if(brands.includes("msf1"))return ".anim.heif";
  if(brands.some(brand=>["heic","heix","hevc","hevx","mif1"].includes(brand)))return ".heif";
  return ".bin";
}
export function validImageMasterSuffix(value: string): boolean { return /^\.(?:anim\.)?(?:png|jpg|jpeg|gif|webp|avif|heif|heic|bin)$/.test(value); }
