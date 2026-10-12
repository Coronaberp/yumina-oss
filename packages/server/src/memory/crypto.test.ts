import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptMemoryText, decryptMemoryText } from './crypto.js';
const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const reference = 'enc:gAAAAABlU_EAmk7Kz3T5yid1pHUVo-_UPXtPXPmRfntO4FHbBrhQgSAHopSVZ6LSPUkuqizjA58J_blKSYH2z5HZPiQlk8ywdg==';
test('decrypts an isolated Python cryptography Fernet reference token', () => {
  assert.equal(decryptMemoryText(reference, key), 'gold 🌙');
  assert.equal(decryptMemoryText(reference, Uint8Array.from({length:32}, (_,i)=>i)), 'gold 🌙');
});
test('round trips UTF-8 text with randomized authenticated encryption', () => {
  const a = encryptMemoryText('黄金 🌙', key), b = encryptMemoryText('黄金 🌙', key);
  assert.match(a, /^enc:gAAAA/); assert.notEqual(a,b);
  assert.equal(decryptMemoryText(a,key),'黄金 🌙');
  assert.equal(decryptMemoryText(a, Buffer.alloc(32,42)), '');
  const token=Buffer.from(a.slice(4),'base64url'); token[30]=token[30]!^1;
  assert.equal(decryptMemoryText('enc:'+token.toString('base64url'),key),'');
});
test('preserves source empty, plaintext, already encrypted and invalid-token behavior', () => {
  assert.equal(encryptMemoryText('',key),''); assert.equal(decryptMemoryText('plain',key),'plain');
  assert.equal(encryptMemoryText(reference,key),reference); assert.equal(decryptMemoryText('enc:bad',key),'');
  assert.throws(()=>encryptMemoryText('text','bad'), /key/i);
});
