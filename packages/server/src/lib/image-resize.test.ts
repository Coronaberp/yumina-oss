import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transform } from "sucrase";

test("the retired background resizer schedules no storage, decoder or database work", async () => {
  let reads = 0, writes = 0, databaseWrites = 0, decodes = 0;
  const imports: string[] = [];
  const module = { exports: {} as { resizeUploadedImageInBackground(key: string, mimeType: string, assetId?: string): void } };
  const dependencies: Record<string, unknown> = {
    "sharp": () => { decodes++; throw new Error("Legacy master decode is forbidden"); },
    "drizzle-orm": { eq: () => undefined },
    "./s3.js": { getObjectBuffer: async () => { reads++; return { buffer: Buffer.alloc(0), contentType: "image/png" }; }, putObject: async () => { writes++; } },
    "../db/index.js": { db: { update: () => { databaseWrites++; throw new Error("No legacy master accounting mutation"); } } },
    "../db/schema.js": { userAssets: {} },
  };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./image-resize.ts", import.meta.url), "utf8"), { transforms: ["typescript", "imports"] }).code)(
    (name: string) => { imports.push(name); assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; }, module, module.exports,
  );
  for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/apng", "image/avif", "image/tiff"]) {
    assert.equal(module.exports.resizeUploadedImageInBackground("users/test/untouched-original", mimeType, "asset-fixture"), undefined);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual({ reads, writes, databaseWrites, decodes }, { reads: 0, writes: 0, databaseWrites: 0, decodes: 0 });
  assert.deepEqual(imports, [], "a compatibility no-op must not initialize storage, Sharp or DB dependencies");
});
