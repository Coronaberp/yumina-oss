import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "../lib/types.js";

process.env.YUMINA_EDITION = "local";
await import("../test/database-fixture.js");
const { db } = await import("../db/index.js");
const { user, worlds, worldPendingEdits } = await import("../db/schema.js");
const { worldRoutes } = await import("./worlds.js");

after(async () => { if (db.$client instanceof PGlite && !db.$client.closed) await db.$client.close(); });

test("independent page banners persist with narrow previews and existing review/access rules", async t => {
  const owner = crypto.randomUUID(), viewer = crypto.randomUUID();
  const worldId = crypto.randomUUID(), draftId = crypto.randomUUID();
  const approved = "@asset:11111111-1111-4111-8111-111111111111";
  const replacement = "@asset:22222222-2222-4222-8222-222222222222";
  const crop = { x: 0, y: 0, zoom: 1, fit: "contain" };
  const schema = { id: worldId, name: "Banner story", description: "", author: "Author", version: "21.0.0", entries: [{ id: "hidden", content: "PRIVATE LORE" }], variables: [], rules: [], components: [], customUI: [], audioTracks: [], settings: {}, bannerImageUrl: approved, bannerCrop: { ...crop, privateExtra: { source: "PRIVATE CROP SOURCE" } }, customData: { source: "PRIVATE CUSTOM SOURCE" } };
  await db.insert(user).values([
    { id: owner, name: "Banner owner", email: `${owner}@test.local` },
    { id: viewer, name: "Viewer", email: `${viewer}@test.local` },
  ]);
  await db.insert(worlds).values([
    { id: worldId, creatorId: owner, name: "Banner story", status: "published", isPublished: true, thumbnailUrl: "/cdn/portrait", schema },
    { id: draftId, creatorId: owner, name: "Private draft", language: "en", schema: { ...schema, id: draftId } },
  ]);
  let actor = owner;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  for (const [method, path] of [["GET", "/:id"], ["PATCH", "/:id"], ["POST", "/"], ["POST", "/:id/add-language-variant"]] as const) {
    const handler = worldRoutes.routes.filter(route => route.method === method && route.path === path).at(-1)!.handler;
    app.on(method, path, handler);
  }
  const write = (method: string, path: string, body: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  await t.test("preview exposes only resolved banner display metadata and keeps the portrait", async () => {
    const response = await app.request(`/${worldId}?preview=true`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Record<string, unknown> };
    assert.match(body.data.bannerImageUrl as string, /\/cdn\/11111111-1111-4111-8111-111111111111$/);
    assert.deepEqual(body.data.bannerCrop, crop);
    assert.equal(body.data.thumbnailUrl, "/cdn/portrait");
    assert.equal(body.data.schema, undefined);
    assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  });

  await t.test("private preview remains inaccessible to another viewer", async () => {
    actor = viewer;
    const response = await app.request(`/${draftId}?preview=true`);
    assert.equal(response.status, 404);
    assert.ok(!await response.text().then(text => text.includes("PRIVATE")));
    actor = owner;
  });

  await t.test("banner framing alone follows existing cosmetic crop saves", async () => {
    const framed = { ...schema, bannerCrop: { ...crop, x: 6 } };
    const response = await write("PATCH", `/${worldId}`, { schema: framed });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!.schema, framed);
    assert.equal((await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId))).length, 0);
    const reset = await write("PATCH", `/${worldId}`, { schema });
    assert.equal(reset.status, 200, await reset.text());
  });

  await t.test("malformed new metadata is rejected on create, update and variant import without writes", async () => {
    const before = await db.select().from(worlds);
    for (const metadata of [
      { bannerImageUrl: null }, { bannerImageUrl: 42 }, { bannerImageUrl: "https://example.test/banner.png" },
      { bannerImageUrl: "@asset:bad" }, { bannerCrop: null }, { bannerCrop: { x: 46 } },
      { bannerCrop: { zoom: 0 } }, { bannerCrop: { fit: "stretch" } },
    ]) {
      for (const [method, path] of [["POST", "/"], ["PATCH", `/${draftId}`], ["POST", `/${draftId}/add-language-variant`]]) {
        const response = await write(method!, path!, { name: "Rejected banner", language: "en", schema: { ...metadata, custom: "preserve me" } });
        assert.equal(response.status, 400, await response.text());
      }
    }
    assert.deepEqual(await db.select().from(worlds), before);
  });

  await t.test("valid partial create and update preserve custom schema without full parsing", async () => {
    const partial = { bannerImageUrl: replacement, bannerCrop: crop, custom: { script: "CUSTOM CODE", nested: [1, "keep"] } };
    const created = await write("POST", "/", { name: "Partial banner card", schema: partial });
    assert.equal(created.status, 201, await created.clone().text());
    const createData = await created.json() as { data: { id: string } };
    const saved = (await db.select().from(worlds).where(eq(worlds.id, createData.data.id)))[0]!;
    assert.deepEqual(saved.schema, { ...partial, name: "Partial banner card" });
    const updated = await write("PATCH", `/${draftId}`, { schema: partial });
    assert.equal(updated.status, 200, await updated.text());
    assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, draftId)))[0]!.schema, partial);
    const imported = await write("POST", `/${draftId}/add-language-variant`, { schema: partial, language: "fr", name: "Imported banner" });
    assert.equal(imported.status, 201, await imported.clone().text());
    const importedData = await imported.json() as { data: { world: { id: string } } };
    assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, importedData.data.world.id)))[0]!.schema, partial);
  });

  await t.test("banner replacement is held for cover review and only the owner edits the working copy", async () => {
    const proposed = { ...schema, bannerImageUrl: replacement, bannerCrop: { ...crop, x: 5 } };
    const response = await write("PATCH", `/${worldId}`, { schema: proposed });
    assert.equal(response.status, 200, await response.text());
    const live = (await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!;
    assert.deepEqual(live.schema, schema);
    assert.equal(live.thumbnailUrl, "/cdn/portrait");
    const held = (await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId)))[0]!;
    assert.deepEqual(held.reasons, ["cover"]);
    assert.deepEqual(held.schema, proposed);
    const edit = await (await app.request(`/${worldId}?forEdit=1`)).json() as { data: Record<string, unknown> };
    assert.match(edit.data.bannerImageUrl as string, /\/cdn\/22222222-2222-4222-8222-222222222222$/);
    assert.deepEqual(edit.data.bannerCrop, { ...crop, x: 5 });
    actor = viewer;
    const preview = await (await app.request(`/${worldId}?preview=true`)).json() as { data: Record<string, unknown> };
    assert.match(preview.data.bannerImageUrl as string, /\/cdn\/11111111-1111-4111-8111-111111111111$/);
    assert.deepEqual(preview.data.bannerCrop, crop);
    assert.equal(preview.data.schema, undefined);
    actor = owner;
  });

  await t.test("explicit removal persists independently while the approved banner stays live", async () => {
    const response = await write("PATCH", `/${worldId}`, { schema: { ...schema, bannerImageUrl: "", bannerCrop: undefined } });
    assert.equal(response.status, 200, await response.text());
    const edit = await (await app.request(`/${worldId}?forEdit=1`)).json() as { data: Record<string, unknown> };
    assert.equal(edit.data.bannerImageUrl, null);
    assert.equal(edit.data.bannerCrop, null);
    assert.equal(edit.data.thumbnailUrl, "/cdn/portrait");
    assert.equal((await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!.schema.bannerImageUrl, approved);
  });
});
