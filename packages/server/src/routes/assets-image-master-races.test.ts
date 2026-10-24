import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Context, Hono } from "hono";
import { transform } from "sucrase";
import type { DrizzleDB } from "../db/index.js";
import { IMAGE_MASTERS_DDL } from "../db/image-masters-ddl.js";
import { createImageMasterService, ImageMasterError, isImageMasterKey, validSourceSha256, type ImageMaster } from "../lib/image-master-service.js";
import type { AppEnv } from "../lib/types.js";

const client = new PGlite();
const database = drizzle(client) as unknown as DrizzleDB;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const imageMasters = createImageMasterService(database, {
  encode: async bytes => ({ bytes, sourceSha256: digest(bytes), storedSha256: digest(bytes), originalSize: bytes.length, storedSize: bytes.length }),
  write: async () => {},
});
const source = new URL("./assets.ts", import.meta.url);
const require = createRequire(source);
const module = { exports: {} as { assetRoutes: Hono<AppEnv> } };
let store: (input: { key: string; sourceSha256?: string }) => Promise<ImageMaster> = async () => assert.fail("Unexpected image registration");
const mocks: Record<string, unknown> = {
  "../db/index.js": { db: database },
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => { c.set("user", { id: "alice" } as AppEnv["Variables"]["user"]); await next(); } },
  "../lib/s3.js": { isS3Configured: () => true, storageKind: () => "s3", deleteObject: async () => {} },
  "../lib/cdn-url.js": { resolveImageCdn: (key: string) => `https://cdn.fixture.test/${key}` },
  "../lib/pending-edit.js": { applyWorldCover: async () => assert.fail("Unexpected cover update") },
  "../lib/image-masters.js": { imageMasters, ImageMasterError, isImageMasterKey, validSourceSha256, storeUploadedImage: (input: { key: string; sourceSha256?: string }) => store(input) },
};
new Function("require", "module", "exports", transform(readFileSync(source, "utf8"), { transforms: ["typescript", "imports"] }).code)(
  (id: string) => mocks[id] ?? require(id), module, module.exports,
);

before(async () => {
  await client.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice');
    CREATE TABLE worlds (id text PRIMARY KEY, creator_id text);
    CREATE TABLE assets (id text PRIMARY KEY, world_id text, type text, filename text, url text, size_bytes integer, mime_type text, created_at timestamp DEFAULT now());
  `);
  await client.exec(IMAGE_MASTERS_DDL);
});
after(async () => { await client.close(); });

for (const mode of ["different", "same", "omitted"] as const) {
  test(`world image registration reconciles the conflict winner (${mode} digest)`, async () => {
    const worldId = crypto.randomUUID();
    await client.query("INSERT INTO worlds (id, creator_id) VALUES ($1, 'alice')", [worldId]);
    const firstBytes = Buffer.from(`world winner ${mode}`);
    const secondBytes = mode === "same" ? firstBytes : Buffer.from(`world loser ${mode}`);
    const firstMaster = await imageMasters.store({ userId: "alice", access: "public", bytes: firstBytes, mimeType: "image/png" });
    const secondMaster = await imageMasters.store({ userId: "alice", access: "public", bytes: secondBytes, mimeType: "image/png" });
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
    const entered = [deferred(), deferred()];
    const released = [deferred(), deferred()];
    const requestId = crypto.randomUUID();
    const body = (index: number, master: ImageMaster) => ({ requestId, key: `worlds/${worldId}/image/${index}.png`, filename: `${index}.png`, type: "image", mimeType: "image/png", sizeBytes: master.originalSize,
      ...(mode === "omitted" ? {} : { sourceSha256: index ? master.sourceSha256.toUpperCase() : master.sourceSha256 }) });
    const firstBody = body(0, firstMaster);
    const secondBody = body(1, secondMaster);
    const post = (value: object) => module.exports.assetRoutes.request(`/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    let stores = 0;
    store = async input => {
      const index = stores++;
      assert.ok(index < 2);
      assert.equal(input.key, index ? secondBody.key : firstBody.key);
      entered[index]!.resolve();
      await released[index]!.promise;
      return index ? secondMaster : firstMaster;
    };
    let winnerRequest: Response | Promise<Response> | undefined;
    let loserRequest: Response | Promise<Response> | undefined;
    try {
      winnerRequest = post(firstBody);
      await entered[0]!.promise;
      loserRequest = post(secondBody);
      await entered[1]!.promise;
      assert.equal(stores, 2, "Both requests passed their initial missing-row lookup");
      released[0]!.resolve();
      const winner = await winnerRequest;
      assert.equal(winner.status, 201, await winner.clone().text());
      const winnerData = (await winner.json() as { data: { id: string; url: string; filename: string; sizeBytes: number } }).data;
      released[1]!.resolve();
      const loser = await loserRequest;
      assert.equal(loser.status, mode === "different" ? 409 : 201, await loser.clone().text());
      if (mode !== "different") {
        assert.deepEqual((await loser.json() as { data: typeof winnerData }).data, winnerData,
          "The reconciled response must describe the winner, including its public URL");
      }
      const rows = (await client.query<{ url: string; filename: string }>("SELECT url, filename FROM assets WHERE world_id = $1", [worldId])).rows;
      assert.deepEqual(rows, [{ url: firstMaster.key, filename: firstBody.filename }]);
      assert.equal(winnerData.url, `https://cdn.fixture.test/${firstMaster.key}`);
    } finally {
      released.forEach(value => value.resolve());
      await Promise.allSettled([winnerRequest, loserRequest]);
      store = async () => assert.fail("Unexpected image registration");
    }
  });
}
