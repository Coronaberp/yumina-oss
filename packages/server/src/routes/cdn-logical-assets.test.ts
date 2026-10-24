import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Hono } from "hono";
import { transform } from "sucrase";
import type { DrizzleDB } from "../db/index.js";

const client = new PGlite();
const database = drizzle(client) as unknown as DrizzleDB;
const source = new URL("./cdn.ts", import.meta.url);
const require = createRequire(source);
const compiled = transform(readFileSync(source, "utf8"), { transforms: ["typescript", "imports"] }).code;
const bytes = Buffer.from("retained exact original image bytes");
const etag = createHash("sha256").update(bytes).digest("hex");
const masterKey = `users/alice/image-masters/public/${etag}.png`;
const privateKey = "private-session-media/alice/objects/image/main.png";
const assetA = "logical-world-image";
const assetB = "logical-user-image";
const privateAsset = "logical-private-image";
const objects = new Map([[masterKey, bytes], [privateKey, Buffer.from("private bytes")]]);
let storageReads = 0;
let storageHeads = 0;

function metadata(key: string) {
  const body = objects.get(key);
  assert.ok(body, `Unexpected storage key: ${key}`);
  return { contentType: "image/png", contentLength: body.length, etag };
}

function loadRoutes(): Hono {
  const module = { exports: {} as { cdnRoutes: Hono } };
  const mocks: Record<string, unknown> = {
    "../db/index.js": { db: database },
    "../lib/s3.js": {
      isS3Configured: () => true,
      headObject: async (key: string) => { storageHeads++; return metadata(key); },
      getObject: async (key: string) => {
        storageReads++;
        return { ...metadata(key), body: Readable.from([objects.get(key)!]), contentRange: null };
      },
      getObjectBuffer: async () => assert.fail("These requests do not generate image variants"),
      putObject: async () => assert.fail("CDN requests must not write objects"),
    },
    "../lib/portrait-variant.js": { createPortraitVariants: () => async () => undefined },
  };
  new Function("require", "module", "exports", compiled)(
    (id: string) => mocks[id] ?? require(id), module, module.exports,
  );
  return module.exports.cdnRoutes;
}

before(async () => {
  await client.exec(`
    CREATE TABLE assets (id text PRIMARY KEY, url text NOT NULL);
    CREATE TABLE user_assets (id text PRIMARY KEY, url text NOT NULL);
  `);
  await client.query("INSERT INTO assets (id, url) VALUES ($1, $2), ($3, $4)", [assetA, masterKey, privateAsset, privateKey]);
  await client.query("INSERT INTO user_assets (id, url) VALUES ($1, $2)", [assetB, masterKey]);
});
after(async () => { await client.close(); });

test("deleted logical IDs disappear on warm and cold CDN routes while their shared master remains available", async () => {
  const warmRoutes = loadRoutes();
  const original = await warmRoutes.request(`/${assetA}`);
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  assert.equal(original.headers.get("etag"), `"${etag}"`);
  assert.equal(original.headers.get("cache-control"), "public, max-age=0, s-maxage=300, must-revalidate");

  await client.query("DELETE FROM assets WHERE id = $1", [assetA]);
  assert.ok(objects.has(masterKey), "Deleting a logical asset retains its shared physical master");
  const coldRoutes = loadRoutes();
  const beforeDeletedReads = { reads: storageReads, heads: storageHeads };
  const requestModes: RequestInit[] = [{}, { method: "HEAD" }, { headers: { "If-None-Match": original.headers.get("etag")! } }];
  for (const options of requestModes) {
    const warm = await warmRoutes.request(`/${assetA}`, options);
    const cold = await coldRoutes.request(`/${assetA}`, options);
    assert.equal(warm.status, 404, `A deleted ID must be missing for ${options.method ?? "GET"} on a warm route`);
    assert.equal(cold.status, 404);
    assert.equal(warm.headers.get("etag"), cold.headers.get("etag"));
    assert.equal(warm.headers.get("cache-control"), cold.headers.get("cache-control"));
    assert.equal(await warm.text(), await cold.text());
  }
  assert.deepEqual({ reads: storageReads, heads: storageHeads }, beforeDeletedReads,
    "A missing logical binding must be rejected before reading a retained master");

  for (const routes of [warmRoutes, coldRoutes]) {
    const sibling = await routes.request(`/${assetB}`);
    assert.equal(sibling.status, 200);
    assert.deepEqual(Buffer.from(await sibling.arrayBuffer()), bytes);
    assert.equal(sibling.headers.get("etag"), original.headers.get("etag"));
    assert.equal(sibling.headers.get("cache-control"), original.headers.get("cache-control"));

    const raw = await routes.request(`/key/${Buffer.from(masterKey).toString("base64url")}`);
    assert.equal(raw.status, 200);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
    assert.equal(raw.headers.get("etag"), original.headers.get("etag"));
    assert.equal(raw.headers.get("cache-control"), original.headers.get("cache-control"));

    const beforePrivateReads = { reads: storageReads, heads: storageHeads };
    assert.equal((await routes.request(`/${privateAsset}`)).status, 404);
    assert.equal((await routes.request(`/key/${Buffer.from(privateKey).toString("base64url")}`)).status, 400);
    assert.deepEqual({ reads: storageReads, heads: storageHeads }, beforePrivateReads,
      "Private keys remain denied before any storage access");
  }
});
