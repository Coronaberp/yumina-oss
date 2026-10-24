import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transform } from "sucrase";
import sharp from "sharp";
import type * as References from "./studio-image-references.js";
import { isImageMasterKey } from "./image-master-service.js";

const owner = "reference-owner";
const key = `users/${owner}/image-masters/public/${"a".repeat(64)}.anim.png`;
let available = true, reads = 0, lookups = 0;
let source: Buffer;
const file = new URL("./studio-image-references.ts", import.meta.url), require = createRequire(file);
const module = { exports: {} as typeof References };
const lookup = async (userId: string, access: string, candidate: string) => {
  lookups++; assert.equal(userId, owner); assert.equal(access, "public");
  return available && candidate === key ? { key, originalSize: source.length, mimeType: "image/png" } : undefined;
};
const read = async (candidate: string) => { reads++; assert.equal(candidate, key); return { buffer: source, contentType: "image/png" }; };
const mocks: Record<string, unknown> = {
  "./image-masters.js": { imageMasters: { findByKey: lookup }, isImageMasterKey },
  "./s3.js": { getObjectBuffer: read },
  "./cdn-url.js": { resolveImageCdn: (candidate: string) => `/cdn/key/${Buffer.from(candidate).toString("base64url")}` },
  "./studio-tools/asset-catalog.js": {}, "./studio-image-view.js": {},
};
new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)(
  (id: string) => mocks[id] ?? require(id), module, module.exports);

test("canonical Studio master references survive normalization and history with rebuilt source URLs", () => {
  const [ref] = module.exports.normalizeStudioChatReferences(owner, [{ key, name: "animation.png", mimeType: "image/png", url: "https://untrusted.test/other" }]);
  assert.equal(ref!.key, key); assert.ok(!ref!.url.includes("untrusted.test"));
  const latest = module.exports.latestStudioImageReferences(owner, [{ role: "user", content: [{ type: "image_url", image_url: { url: ref!.url } }] }]);
  assert.equal(latest[0]!.key, key);
  for (const candidate of [key.replace(`users/${owner}/`, "users/other/"), key.replace("/public/", "/private/"), key.replace(".anim.png", "/../image.png")]) {
    assert.throws(() => module.exports.normalizeStudioChatReferences(owner, [{ key: candidate, mimeType: "image/png" }]), /own uploaded images/);
  }
});

test("every asynchronous native reference read verifies the exact owner/public registry first", async () => {
  source = await sharp({ create: { width: 2000, height: 2, channels: 4, background: "#12345680" } }).png().toBuffer();
  const before = createHash("sha256").update(source).digest("hex");
  const refs = [{ key, url: `/cdn/key/${Buffer.from(key).toString("base64url")}`, name: "Original" }];
  for (const mode of ["inputs", "images"]) {
    available = false; reads = 0; lookups = 0;
    const load = () => mode === "inputs" ? module.exports.loadStudioImageReferenceInputs(owner, undefined, refs)
      : module.exports.loadStudioImageReferences(owner, refs, undefined, read);
    await assert.rejects(load(), /reference|image|owned/i); assert.equal(reads, 0); assert.equal(lookups, 1);
    available = true;
    const result = await load(); assert.equal(reads, 1); assert.equal(lookups, 2);
    const png = mode === "inputs" ? (result as Array<{ bytes: Buffer }>)[0]!.bytes : Buffer.from((result as string[])[0]!.split(",")[1]!, "base64");
    assert.equal((await sharp(png).metadata()).width, 1536, "provider inputs remain explicit derivatives");
    assert.equal(createHash("sha256").update(source).digest("hex"), before, "reading never changes the master");
  }
});
