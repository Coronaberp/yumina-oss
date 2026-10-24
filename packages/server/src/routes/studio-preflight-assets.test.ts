import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Hono, Context } from "hono";
import type { AppEnv } from "../lib/types.js";
import type * as AssetCatalog from "../lib/studio-tools/asset-catalog.js";

const client = new PGlite();
const query = client.query.bind(client);
let inflight = 0, peak = 0, queries = 0, failAssetCheck = false;
const measuredQuery = (async (...args: Parameters<typeof client.query>) => {
  queries++;
  inflight++;
  peak = Math.max(peak, inflight);
  try {
    if (failAssetCheck && args[0].includes('"user_assets"')) {
      throw Object.assign(new Error("remaining connection slots are reserved for roles with the SUPERUSER attribute"), { code: "53300" });
    }
    return await query(...args);
  } finally { inflight--; }
}) as typeof client.query;
const database = { db: drizzle({ query: measuredQuery } as PGlite) };
function load<T>(file: URL, mocks: Record<string, unknown>, stubOtherImports = false): T {
  const require = createRequire(file);
  const module = { exports: {} as T };
  new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)(
    (id: string) => mocks[id] ?? (stubOtherImports && id.startsWith("../") ? {} : require(id)), module, module.exports,
  );
  return module.exports;
}
const catalog = load<typeof AssetCatalog>(new URL("../lib/studio-tools/asset-catalog.ts", import.meta.url), { "../../db/index.js": database });
let refs: string[] = [], userId = "alice";
const routes = load<{ studioRoutes: Hono<AppEnv> }>(new URL("./studio.ts", import.meta.url), {
  "../db/index.js": database,
  "../db/schema.js": createRequire(import.meta.url)("../db/schema.ts"),
  "@yumina/engine": { migrateWorldDefinition: (schema: unknown) => schema },
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => { c.set("user", { id: userId } as AppEnv["Variables"]["user"]); await next(); } },
  "../lib/pending-edit.js": { resolveWorkingSchema: async (_id: string, _status: string, schema: unknown) => schema },
  "../lib/studio-tools/asset-catalog.js": catalog,
  "../lib/studio-tools/project-intelligence.js": { getStructuralPreflight: () => ({ clean: true, blockingErrors: [], warnings: [], analysisComplete: true, assetRefs: refs }) },
}, true).studioRoutes;
before(async () => {
  await client.exec(`
    CREATE TABLE worlds (id text, creator_id text, schema jsonb, status text, is_published boolean);
    INSERT INTO worlds VALUES ('mine','alice','{}','draft',false),('theirs','bob','{}','draft',false);
    CREATE TABLE user_assets (id text, user_id text, type text);
    CREATE TABLE assets (id text, world_id text, type text);
    INSERT INTO user_assets SELECT 'image-'||i, 'alice','image' FROM generate_series(0,649) i;
    INSERT INTO user_assets VALUES ('private','bob','image'),('audio','alice','audio'),('both','alice','image');
    INSERT INTO assets VALUES ('world-image','mine','image'),('other-world','theirs','image'),('world-audio','mine','audio'),('both','mine','image');
  `);
});
after(async () => client.close());
const request = () => routes.request("/mine/preflight");
function reset() { peak = 0; queries = 0; failAssetCheck = false; userId = "alice"; }

test("a card with hundreds of valid images does not exhaust database connections", async () => {
  reset(); refs = Array.from({ length: 650 }, (_, i) => `@asset:image-${i}`);
  const response = await request();
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { clean: boolean; blockingErrors: unknown[] } };
  assert.deepEqual(body.data.blockingErrors, []);
  assert.equal(body.data.clean, true);
  assert.ok(peak <= 2, `asset lookups must be bounded; observed ${peak}`);
  assert.ok(queries <= 12, `asset lookups must be batched; observed ${queries}`);
});

test("only verified missing, private or nonimage assets produce image findings", async () => {
  reset(); refs = ["image-0", "world-image", "both", "private", "audio", "other-world", "world-audio", "absent"].map(id => `@asset:${id}`);
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json() as { data: { blockingErrors: { code: string; evidence: string }[] } };
  assert.deepEqual(body.data.blockingErrors.map(row => row.evidence), refs.slice(3));
  assert.ok(body.data.blockingErrors.every(row => row.code === "missing-image-asset"));
});

test("database capacity failure is retryable and never claims artwork is missing", async () => {
  reset(); refs = ["@asset:image-0"]; failAssetCheck = true;
  try {
    const response = await request(); assert.equal(response.status, 503);
    const body = await response.json() as { code: string; error: string; data?: unknown };
    assert.equal(body.code, "ASSET_CHECK_UNAVAILABLE");
    assert.match(body.error, /try again/i);
    assert.doesNotMatch(body.error, /SUPERUSER|53300|@asset:|missing|import/i);
    assert.equal(body.data, undefined);
  } finally { failAssetCheck = false; }
});

test("duplicate image references are checked once and unauthorized cards fail closed", async () => {
  reset(); refs = Array(100).fill("@asset:image-0");
  const response = await request(); assert.equal(response.status, 200);
  assert.equal((await response.json() as { data: { clean: boolean } }).data.clean, true);
  assert.ok(queries <= 4);
  queries = 0; userId = "bob";
  assert.equal((await request()).status, 404); assert.equal(queries, 1);
  userId = "alice";
});

test("single-image assignment still verifies ownership, type and reference syntax", async () => {
  reset();
  await catalog.assertOwnedVnImageRef("alice", "mine", "@asset:world-image");
  await assert.rejects(catalog.assertOwnedVnImageRef("bob", "mine", "@asset:world-image"), /authorized/);
  for (const ref of ["@asset:audio", "@asset:private", "@asset:absent", "https://example.com/image.png", null]) {
    await assert.rejects(catalog.assertOwnedVnImageRef("alice", "mine", ref));
  }
});
