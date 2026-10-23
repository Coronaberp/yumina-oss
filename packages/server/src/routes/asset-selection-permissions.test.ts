import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../db/index.js";
import { assets, user, userAssets, worlds, worldPendingEdits } from "../db/schema.js";
import { assetRoutes } from "./assets.js";
import type { AppEnv } from "../lib/types.js";

after(async () => { if (db.$client instanceof PGlite) await db.$client.close(); });

test("cover and gallery selection authorize the source before changing the target", async (t) => {
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  await db.insert(user).values([
    { id: owner, name: "Owner", email: `${owner}@test.invalid` },
    { id: other, name: "Other", email: `${other}@test.invalid` },
  ]);
  const makeWorld = async (creatorId = owner, status: "draft" | "published" = "draft") => {
    const id = crypto.randomUUID();
    await db.insert(worlds).values({ id, creatorId, name: "Selection target", status,
      thumbnailUrl: "worlds/original/cover.webp", galleryImages: ["worlds/original/gallery.webp"],
      schema: { id, version: "20.0.0", name: "Selection target", firstMessage: "", entries: [], variables: [], rules: [] },
    });
    return id;
  };
  const foreignWorld = await makeWorld(other), sameOwnerWorld = await makeWorld();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: c.req.header("x-test-user") ?? owner } as AppEnv["Variables"]["user"]);
    await next();
  });
  for (const suffix of ["thumbnail", "gallery"]) {
    const path = `/worlds/:worldId/${suffix}/from-asset`;
    app.on("POST", path, assetRoutes.routes.filter(r => r.path === path && r.method === "POST").at(-1)!.handler);
  }
  const snapshot = async (worldId: string) => ({
    world: await db.select().from(worlds).where(eq(worlds.id, worldId)),
    pending: await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId)),
  });
  const cases = [
    { name: "target-world image", source: "world", type: "image", want: 200 },
    { name: "foreign-world image", source: "foreign", type: "image", want: 404 },
    { name: "same-owner different-world image", source: "same-owner-world", type: "image", want: 404 },
    { name: "own private image", source: "own", type: "image", want: 200 },
    { name: "other user's public image", source: "public", type: "image", want: 200 },
    { name: "other user's private image", source: "private", type: "image", want: 404 },
    { name: "missing image", source: "missing", type: "image", want: 404 },
    { name: "world audio", source: "world", type: "audio", want: 400 },
    { name: "own audio", source: "own", type: "audio", want: 400 },
    { name: "world video", source: "world", type: "video", want: 400 },
    { name: "own video", source: "own", type: "video", want: 400 },
    { name: "non-owner target", source: "world", type: "image", want: 404, actor: other },
  ] as const;
  for (const suffix of ["thumbnail", "gallery"]) {
    for (const scenario of cases) await t.test(`${suffix}: ${scenario.name}`, async () => {
      const worldId = await makeWorld();
      const assetId = crypto.randomUUID();
      const legacy = ["world", "foreign", "same-owner-world"].includes(scenario.source);
      const sourceWorld = scenario.source === "foreign" ? foreignWorld : scenario.source === "same-owner-world" ? sameOwnerWorld : worldId;
      const sourceOwner = scenario.source === "own" ? owner : other;
      const key = legacy ? `worlds/${sourceWorld}/image/${assetId}.webp` : `users/${sourceOwner}/images/${assetId}.webp`;
      const metadata = { id: assetId, type: scenario.type, filename: `${assetId}.webp`, url: key };
      if (legacy) await db.insert(assets).values({ ...metadata, worldId: sourceWorld });
      else if (scenario.source !== "missing") await db.insert(userAssets).values({ ...metadata,
        userId: sourceOwner, isPublic: scenario.source === "public",
      });
      const before = await snapshot(worldId);
      const response = await app.request(`/worlds/${worldId}/${suffix}/from-asset`, { method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": "actor" in scenario ? scenario.actor : owner },
        body: JSON.stringify({ assetId }),
      });
      assert.equal(response.status, scenario.want, await response.clone().text());
      if (scenario.want !== 200) assert.deepEqual(await snapshot(worldId), before, "rejection leaves live and pending material untouched");
      else {
        const [changed] = await db.select().from(worlds).where(eq(worlds.id, worldId));
        if (suffix === "thumbnail") assert.equal(changed!.thumbnailUrl, key);
        else assert.deepEqual(changed!.galleryImages, ["worlds/original/gallery.webp", key]);
        const [source] = legacy ? await db.select().from(assets).where(eq(assets.id, assetId)) : await db.select().from(userAssets).where(eq(userAssets.id, assetId));
        assert.equal(source!.url, key, "library source remains intact without transcoding");
      }
    });
  }
  await t.test("published cover selection stays in its held edit", async () => {
    const worldId = await makeWorld(owner, "published"), assetId = crypto.randomUUID();
    const key = `users/${owner}/images/${assetId}.webp`;
    await db.insert(userAssets).values({ id: assetId, userId: owner, type: "image", filename: "cover.webp", url: key });
    const response = await app.request(`/worlds/${worldId}/thumbnail/from-asset`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { data: { heldForReview: boolean } }).data.heldForReview, true);
    const material = await snapshot(worldId);
    assert.equal(material.world[0]!.thumbnailUrl, "worlds/original/cover.webp");
    assert.equal(material.pending[0]!.thumbnailUrl, key);
    const privateId = crypto.randomUUID();
    await db.insert(userAssets).values({ id: privateId, userId: other, type: "image", filename: "private.webp", url: `users/${other}/private.webp` });
    for (const suffix of ["thumbnail", "gallery"]) {
      const rejected = await app.request(`/worlds/${worldId}/${suffix}/from-asset`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: privateId }),
      });
      assert.equal(rejected.status, 404);
      assert.deepEqual(await snapshot(worldId), material, "rejection also preserves an existing held edit");
    }
  });
});
