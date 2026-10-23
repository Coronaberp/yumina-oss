import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { getLocalDiskStorage } from "../lib/s3.js";
import type { AppEnv } from "../lib/types.js";
import { assetRoutes } from "./assets.js";
import { userAssetRoutes } from "./user-assets.js";
import { worldRoutes } from "./worlds.js";

const owner = crypto.randomUUID();
const worldId = crypto.randomUUID();
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("user", { id: owner } as AppEnv["Variables"]["user"]);
  await next();
});
const paths = [
  { source: userAssetRoutes, pattern: "/upload-url", mount: "/user-assets/upload-url", path: "/user-assets/upload-url" },
  { source: assetRoutes, pattern: "/worlds/:worldId/assets/upload-url", mount: "/worlds/:worldId/assets/upload-url", path: `/worlds/${worldId}/assets/upload-url` },
  { source: assetRoutes, pattern: "/worlds/:worldId/thumbnail", mount: "/worlds/:worldId/thumbnail", path: `/worlds/${worldId}/thumbnail` },
  { source: worldRoutes, pattern: "/:id/gallery/upload-url", mount: "/worlds/:id/gallery/upload-url", path: `/worlds/${worldId}/gallery/upload-url` },
];
for (const entry of paths) {
  const handler = entry.source.routes.filter(route => route.path === entry.pattern && route.method === "POST").at(-1)!.handler;
  app.post(entry.mount, handler);
}
const body = { filename: "sprite.png", contentType: "image/png", type: "image" };
const post = (path: string, payload: string) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });

before(async () => {
  await db.insert(user).values({ id: owner, name: "Length preparation", email: `${owner}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: "Length preparation", schema: {} });
});

for (const { path } of paths) {
  test(`${path} signs supplied sizes with a ten-minute expiry and preserves omitted sizes`, async () => {
    for (const sizeBytes of [0, 3, undefined]) {
      const before = Date.now();
      const response = await post(path, JSON.stringify({ ...body, sizeBytes }));
      assert.equal(response.status, 200, await response.clone().text());
      const { data } = await response.json() as { data: { key: string; uploadUrl: string } };
      const token = new URL(data.uploadUrl, "http://localhost").searchParams.get("token")!;
      const claims = getLocalDiskStorage().verifyUploadToken(token);
      assert.equal(claims?.key, data.key);
      assert.equal(claims?.contentLength, sizeBytes);
      const signed = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
      const ttl = sizeBytes === undefined ? 3_600_000 : 600_000;
      assert.ok(signed.exp >= before + ttl && signed.exp <= Date.now() + ttl);
    }
  });

  test(`${path} refuses provided invalid sizes`, async () => {
    for (const invalid of ["-1", "1.5", "null", '"3"', "1e400", "-1e400", "9007199254740992"]) {
      const payload = `${JSON.stringify(body).slice(0, -1)},"sizeBytes":${invalid}}`;
      const response = await post(path, payload);
      assert.equal(response.status, 400, `${invalid}: ${await response.text()}`);
    }
  });
}
