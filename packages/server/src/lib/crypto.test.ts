import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { env } from "./env.js";
import { decryptApiKey, encryptApiKey } from "./crypto.js";

const current = "synthetic-current-encryption-material";
const retired = "synthetic-retired-encryption-material";
const legacy = "synthetic-legacy-auth-material";
const plaintext = "synthetic-provider-key";
const key = (material: string) => createHash("sha256").update(material).digest();

function seal(material: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(material), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function decrypt(row: ReturnType<typeof seal>) {
  return decryptApiKey(row.encrypted, row.iv, row.tag);
}

function configure(t: TestContext, previous?: string, encryption: string | null = current) {
  // The isolated test launcher disables dotenv and supplies a synthetic auth
  // secret. No developer environment or stored provider keys are read.
  const config = env as typeof env & { ENCRYPTION_KEY_PREVIOUS?: string };
  const saved = { encryption: config.ENCRYPTION_KEY, previous: config.ENCRYPTION_KEY_PREVIOUS, auth: config.BETTER_AUTH_SECRET };
  config.ENCRYPTION_KEY = encryption ?? undefined;
  config.ENCRYPTION_KEY_PREVIOUS = previous;
  config.BETTER_AUTH_SECRET = legacy;
  t.after(() => {
    config.ENCRYPTION_KEY = saved.encryption;
    config.ENCRYPTION_KEY_PREVIOUS = saved.previous;
    config.BETTER_AUTH_SECRET = saved.auth;
  });
}

test("decrypts stored keys encrypted with retired explicit material", t => {
  configure(t, retired);
  assert.equal(decrypt(seal(retired)), plaintext);
});

test("decrypts historical auth-secret rows after an explicit encryption key is introduced", t => {
  configure(t);
  assert.equal(decrypt(seal(legacy)), plaintext);
});

test("tries comma-separated retired material with whitespace, empty entries and duplicates", t => {
  configure(t, ` , ${retired}, ${current}, ${retired}, synthetic-older-auth-material, `);
  assert.equal(decrypt(seal(retired)), plaintext);
  assert.equal(decrypt(seal("synthetic-older-auth-material")), plaintext);
});

test("new encryption uses current material, verified independently of the helper", t => {
  configure(t, retired);
  const row = encryptApiKey(plaintext);
  const decipher = createDecipheriv("aes-256-gcm", key(current), Buffer.from(row.iv, "hex"));
  decipher.setAuthTag(Buffer.from(row.tag, "hex"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(row.encrypted, "hex")), decipher.final()]).toString("utf8"), plaintext);
  assert.equal(decrypt(row), plaintext);
});

test("unset explicit encryption continues writing with the current auth secret", t => {
  configure(t, retired, null);
  const row = encryptApiKey(plaintext);
  const decipher = createDecipheriv("aes-256-gcm", key(legacy), Buffer.from(row.iv, "hex"));
  decipher.setAuthTag(Buffer.from(row.tag, "hex"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(row.encrypted, "hex")), decipher.final()]).toString("utf8"), plaintext);
  assert.equal(decrypt(row), plaintext);
});

test("unknown keys, malformed values and tampered authentication tags fail closed", t => {
  configure(t, retired);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  assert.equal(decrypt(seal("synthetic-unknown-key-material")), null);
  const row = seal(retired);
  const tag = Buffer.from(row.tag, "hex");
  tag[0] = tag[0]! ^ 1;
  assert.equal(decrypt({ ...row, tag: tag.toString("hex") }), null);
  assert.equal(decryptApiKey("not-hex", "bad-iv", "bad-tag"), null);
  assert.equal(errors.length, 3, "only one diagnostic per failed decryption, not per attempted key");
  assert.ok(!JSON.stringify(errors).includes(plaintext));
  assert.ok(!JSON.stringify(errors).includes(retired));
});
