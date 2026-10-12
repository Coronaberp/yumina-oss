import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Inject a memory-store key; never import a StoryHaven deployment key. */
export type MemoryEncryptionKey = string | Uint8Array;
function keyBytes(key: MemoryEncryptionKey): Buffer {
  if (typeof key === 'string' && !/^[A-Za-z0-9_-]{43}=?$/.test(key)) throw new Error('Invalid memory encryption key');
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64url') : Buffer.from(key);
  if (bytes.length !== 32) throw new Error('Invalid memory encryption key');
  return bytes;
}
function paddedUrl64(bytes: Buffer): string { return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); }

/** Source _encrypt_secret semantics, with the standard Fernet wire format. */
export function encryptMemoryText(text: string, key: MemoryEncryptionKey): string {
  if (!text || text.startsWith('enc:')) return text;
  const bytes = keyBytes(key), iv = randomBytes(16), timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const cipher = createCipheriv('aes-128-cbc', bytes.subarray(16), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const signed = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
  const mac = createHmac('sha256', bytes.subarray(0, 16)).update(signed).digest();
  return 'enc:' + paddedUrl64(Buffer.concat([signed, mac]));
}

/** No TTL, as in StoryHaven; corrupt or wrong-key encrypted values return empty. */
export function decryptMemoryText(token: string, key: MemoryEncryptionKey): string {
  if (!token || !token.startsWith('enc:')) return token;
  const bytes = keyBytes(key);
  try {
    const encoded = token.slice(4);
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return '';
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length < 73 || raw[0] !== 0x80 || (raw.length - 57) % 16 !== 0) return '';
    const signed = raw.subarray(0, -32), supplied = raw.subarray(-32);
    const expected = createHmac('sha256', bytes.subarray(0, 16)).update(signed).digest();
    if (!timingSafeEqual(expected, supplied)) return '';
    const decipher = createDecipheriv('aes-128-cbc', bytes.subarray(16), raw.subarray(9, 25));
    const plain = Buffer.concat([decipher.update(raw.subarray(25, -32)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch { return ''; }
}
