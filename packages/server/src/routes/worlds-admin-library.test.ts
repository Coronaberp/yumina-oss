import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, user, userLibrary, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import type { AppEnv } from "../lib/types.js";
import { sessionRoutes } from "./sessions.js";
import { worldRoutes } from "./worlds.js";

// Verified stored ID, intentionally independent from the production helper.
const targetId = "01b05b03-98ac-45cc-8a64-ca7a53c97f10";
const authorId = "nmWoAv7pSZH6buWzOOZya6RxBj4iHiWF";

after(async () => {
  const client = db.$client;
  if (client instanceof PGlite && !client.closed) await client.close();
});

interface Listing {
  data: Array<Record<string, unknown>>;
  adminLibraryItems: Array<Record<string, unknown>>;
  adminLibraryViewerId: string | null;
}

test("admin library listing preserves private drafts and existing access", async (t) => {
  const adminId = crypto.randomUUID();
  const viewerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const publicId = crypto.randomUUID();
  const ownDraftId = crypto.randomUUID();
  const unrelatedId = crypto.randomUUID();
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  const updatedAt = new Date("2026-10-20T00:00:00.000Z");
  const coverCrop = { x: 50, y: 25, zoom: 1.2 };
  const schema = {
    id: targetId, version: "1.0.0", name: "Seiryu Academy", entries: [],
    variables: [], rules: [], settings: {}, firstMessage: "Welcome", coverCrop,
  };
  await db.insert(user).values([
    { id: authorId, name: "filgachtic", email: "author@test.invalid" },
    { id: adminId, name: "Admin", email: "admin@test.invalid", role: "admin" },
    { id: viewerId, name: "Viewer", email: "viewer@test.invalid", role: "user" },
    { id: otherId, name: "Other author", email: "other@test.invalid" },
  ]);
  await db.insert(worlds).values([
    { id: targetId, creatorId: authorId, name: "Seiryu Academy", schema,
      thumbnailUrl: "/cdn/seiryu-cover", status: "draft", isPublished: false,
      allowEdit: false, description: "PRIVATE DESCRIPTION", moderationNote: "PRIVATE NOTE",
      createdAt, updatedAt },
    { id: unrelatedId, creatorId: authorId, name: "Unrelated private story", schema: { secret: "PRIVATE SOURCE" } },
    { id: publicId, creatorId: otherId, name: "Public story", schema: {}, status: "published", isPublished: true },
    { id: ownDraftId, creatorId: adminId, name: "Admin authored draft", schema: {} },
  ]);
  await db.insert(userLibrary).values({ userId: viewerId, worldId: publicId });

  // Keep role intentionally stale/forged: the new gate must use the database.
  let actorId: string = adminId;
  let contextRole = "user";
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: actorId, name: "Context user", role: contextRole } as AppEnv["Variables"]["user"]);
    await next();
  });
  for (const [method, path] of [["GET", "/"], ["GET", "/:id"], ["PATCH", "/:id"]]) {
    const route = worldRoutes.routes.filter((r) => r.method === method && r.path === path).at(-1);
    assert.ok(route);
    app.on(method!, `/worlds${path === "/" ? "" : path}`, route.handler);
  }
  const start = sessionRoutes.routes.filter((r) => r.method === "POST" && r.path === "/").at(-1);
  assert.ok(start);
  app.post("/sessions", start.handler);
  const list = async () => {
    const response = await app.request("/worlds");
    assert.equal(response.status, 200, await response.clone().text());
    return { response, body: await response.json() as Listing };
  };
  const readTarget = async () => (await db.select().from(worlds).where(eq(worlds.id, targetId)))[0]!;
  const beforeTarget = await readTarget();
  const beforeLibrary = await db.select().from(userLibrary);
  const beforeSessions = await db.select().from(playSessions);

  await t.test("admin no longer receives Seiryu as a special library item", async () => {
    const { response, body } = await list();
    assert.equal(body.adminLibraryViewerId, adminId);
    assert.deepEqual(body.adminLibraryItems, []);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(body.data.map((w) => w.id).sort(), [publicId, ownDraftId].sort());
    assert.equal(body.data.find((w) => w.id === ownDraftId)?.status, "draft");
    assert.ok(!JSON.stringify(body).includes("PRIVATE"));
    assert.ok(!JSON.stringify(body).includes(unrelatedId));
  });

  await t.test("nonadmin receives no target metadata even with forged admin context", async () => {
    actorId = viewerId;
    contextRole = "admin";
    const { response, body } = await list();
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(body.adminLibraryItems, []);
    assert.equal(body.adminLibraryViewerId, null);
    assert.deepEqual(body.data.map((w) => w.id), [publicId]);
    const serialized = JSON.stringify(body);
    for (const secret of [targetId, "Seiryu Academy", "filgachtic", "/cdn/seiryu-cover", "PRIVATE", unrelatedId]) {
      assert.ok(!serialized.includes(secret), `${secret} must not reach the nonadmin response`);
    }
  });

  await t.test("database promotion and demotion take effect despite unchanged stale context", async () => {
    actorId = viewerId;
    contextRole = "user";
    const ordinaryData = (await list()).body.data;
    await db.update(user).set({ role: "admin" }).where(eq(user.id, viewerId));
    try {
      const promoted = (await list()).body;
      assert.equal(promoted.adminLibraryViewerId, viewerId);
      assert.equal(promoted.adminLibraryItems.length, 0);
      assert.deepEqual(promoted.data, ordinaryData);
    } finally {
      await db.update(user).set({ role: "user" }).where(eq(user.id, viewerId));
    }
    contextRole = "admin";
    const demoted = (await list()).body;
    assert.equal(demoted.adminLibraryViewerId, null);
    assert.deepEqual(demoted.adminLibraryItems, []);
    assert.deepEqual(demoted.data, ordinaryData);
  });

  await t.test("actual owner retains the same authored draft and gets no duplicate admin entry", async () => {
    actorId = authorId;
    contextRole = "user";
    const ordinaryData = (await list()).body.data;
    await db.update(user).set({ role: "admin" }).where(eq(user.id, authorId));
    try {
      const body = (await list()).body;
      assert.deepEqual(body.data, ordinaryData);
      assert.deepEqual(body.adminLibraryItems, []);
      assert.equal(body.data.filter((w) => w.id === targetId).length, 1);
      const target = body.data.find((w) => w.id === targetId)!;
      assert.equal(target.creatorId, authorId);
      assert.equal(target.status, "draft");
      assert.equal(target.isPublished, false);
    } finally {
      await db.update(user).set({ role: "user" }).where(eq(user.id, authorId));
    }
  });

  await t.test("fixed creator and draft eligibility cannot be broadened by changed target data", async () => {
    actorId = adminId;
    for (const changes of [
      { creatorId: otherId }, { status: "pending_review" }, { status: "published", isPublished: true }, { isPublished: true },
    ]) {
      await db.update(worlds).set(changes).where(eq(worlds.id, targetId));
      try { assert.deepEqual((await list()).body.adminLibraryItems, []); }
      finally {
        await db.update(worlds).set({ creatorId: authorId, status: "draft", isPublished: false }).where(eq(worlds.id, targetId));
      }
    }
  });

  await t.test("listing performs no authored world, library, or session mutations", async () => {
    assert.deepEqual(await readTarget(), beforeTarget);
    assert.deepEqual(await db.select().from(userLibrary), beforeLibrary);
    assert.deepEqual(await db.select().from(playSessions), beforeSessions);
  });

  await t.test("anonymous request to the actual authenticated route stays unauthorized", async () => {
    const login = mock.method(auth.api, "getSession", async () => null);
    try {
      const response = await worldRoutes.request("/");
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    } finally { login.mock.restore(); }
  });

  await t.test("nonadmin cannot inspect private source or acquire edit rights", async () => {
    for (const id of [viewerId, adminId]) {
      actorId = id;
      assert.equal((await app.request(`/worlds/${targetId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Unauthorized change" }),
      })).status, 409);
    }
    actorId = viewerId;
    assert.equal((await app.request(`/worlds/${targetId}?forEdit=1`)).status, 404);
    assert.deepEqual(await readTarget(), beforeTarget);
  });

  await t.test("existing admin preview remains ephemeral and rejects a nonadmin", async () => {
    const startPreview = () => app.request("/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId: targetId, adminPreview: true }),
    });
    actorId = viewerId;
    contextRole = "admin";
    assert.equal((await startPreview()).status, 403);
    actorId = adminId;
    contextRole = "user";
    const response = await startPreview();
    assert.equal(response.status, 201, await response.clone().text());
    const { data } = await response.json() as { data: { id: string; ephemeral: boolean } };
    assert.equal(data.ephemeral, true);
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, data.id));
    assert.equal(saved!.ephemeral, true);
    assert.equal(saved!.userId, adminId);
    assert.deepEqual(await db.select().from(userLibrary), beforeLibrary);
    assert.deepEqual(await readTarget(), beforeTarget);
  });
});
