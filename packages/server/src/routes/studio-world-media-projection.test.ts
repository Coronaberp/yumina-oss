import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../lib/types.js";

process.env.YUMINA_EDITION = "local";
await import("../test/database-fixture.js");
const { db } = await import("../db/index.js");
const { user, worlds, worldPendingEdits } = await import("../db/schema.js");
const { writeStudioWorldSchema } = await import("../lib/pending-edit.js");
const { worldRoutes } = await import("./worlds.js");

after(async () => { if ("close" in db.$client && typeof db.$client.close === "function") await db.$client.close(); });

test("creator media reads preserve an explicit held portrait clear while public reads keep the approved cover", async () => {
  const owner = crypto.randomUUID(), viewer = crypto.randomUUID(), worldId = crypto.randomUUID();
  const schema = { id: worldId, name: "Portrait projection", description: "", author: "Fixture", version: "21.0.0", entries: [], variables: [], rules: [], components: [], customUI: [], audioTracks: [], settings: {}, bannerImageUrl: "", customData: { source: "Keep custom content" } };
  await db.insert(user).values([
    { id: owner, name: "Owner", email: `${owner}@test.local` },
    { id: viewer, name: "Viewer", email: `${viewer}@test.local` },
  ]);
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: schema.name, status: "published", isPublished: true, thumbnailUrl: "/approved-cover", schema });
  let actor = owner;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  const handler = worldRoutes.routes.filter(route => route.method === "GET" && route.path === "/:id").at(-1)!.handler;
  app.get("/:id", handler);
  const read = async (query = "") => {
    const response = await app.request(`/${worldId}${query}`);
    assert.equal(response.status, 200);
    return (await response.json() as { data: Record<string, unknown> }).data;
  };
  try {
    const approvedDisplay = (await read("?forEdit=1")).thumbnailUrl;
    assert.equal(typeof approvedDisplay, "string", "A card without held edits keeps its resolved cover");
    const cleared = await writeStudioWorldSchema({ worldId, creatorId: owner, schema, expectedSchema: schema, thumbnailUrl: null, expectedThumbnailUrl: "/approved-cover" });
    assert.equal(cleared.held, true);
    const [pending] = await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId));
    assert.equal(pending!.thumbnailUrl, null, "The native writer records explicit clear as complete proposed material");
    assert.deepEqual(pending!.schema, schema);
    const edit = await read("?forEdit=1");
    assert.equal(edit.thumbnailUrl, null, "The editor must not resurrect the approved cover after a successful held clear");
    assert.deepEqual(edit.schema, schema);
    assert.equal((await read()).thumbnailUrl, approvedDisplay, "Owner's public view still uses the approved material");
    actor = viewer;
    assert.equal((await read()).thumbnailUrl, approvedDisplay, "Other readers cannot see held cover changes");
    actor = owner;
    await writeStudioWorldSchema({ worldId, creatorId: owner, schema, expectedSchema: schema, thumbnailUrl: "/replacement-cover", expectedThumbnailUrl: null });
    const replacementDisplay = (await read("?forEdit=1")).thumbnailUrl;
    assert.equal(typeof replacementDisplay, "string", "A held replacement still projects normally");
    assert.notEqual(replacementDisplay, approvedDisplay);
    const [live] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    assert.equal(live!.thumbnailUrl, "/approved-cover");
    assert.deepEqual(live!.schema, schema);
  } finally {
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(user).where(eq(user.id, viewer));
  }
});
