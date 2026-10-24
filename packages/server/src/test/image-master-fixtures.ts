import { deflateSync } from "node:zlib";
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}
export function apngFixture() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0); animation.writeUInt32BE(3, 4);
  const frame = (sequence: number, delay: number) => { const data = Buffer.alloc(26); data.writeUInt32BE(sequence, 0); data.writeUInt32BE(2, 4); data.writeUInt32BE(1, 8); data.writeUInt16BE(delay, 20); data.writeUInt16BE(10, 22); return chunk("fcTL", data); };
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("acTL", animation),
    chunk("tEXt", Buffer.from("parameters\0" + "synthetic prompt metadata ".repeat(20))), frame(0, 1),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]))), frame(1, 2),
    chunk("fdAT", Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 0, 255, 255, 180, 100, 10, 0]))])), chunk("IEND", Buffer.alloc(0))]);
}
