import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Hono } from "hono";
import { assertWorldEditable, isWorldEditLocked, worldEditLockMiddleware } from "./world-edit-lock.js";

const previous = process.env.YUMINA_LOCKED_WORLD_IDS;
process.env.YUMINA_LOCKED_WORLD_IDS = "locked-world, second-world";
after(() => {
  if (previous === undefined) delete process.env.YUMINA_LOCKED_WORLD_IDS;
  else process.env.YUMINA_LOCKED_WORLD_IDS = previous;
});

test("temporary locks apply only to configured cards", async () => {
  assert.equal(await isWorldEditLocked("locked-world"), true);
  assert.equal(await isWorldEditLocked("second-world"), true);
  assert.equal(await isWorldEditLocked("another-world"), false);
  await assert.rejects(() => assertWorldEditable("locked-world"), { message: "This card is temporarily locked. Editing is disabled." });
  await assert.doesNotReject(() => assertWorldEditable("another-world"));
});

test("locked editor, assets, versions and Studio requests cannot reach their mutation handlers", async () => {
  const app = new Hono();
  let mutations = 0;
  app.use("/api/*", worldEditLockMiddleware);
  app.all("/api/*", c => { mutations++; return c.json({ ok: true }); });
  const paths = [
    ["PATCH", "/api/worlds/locked-world"],
    ["DELETE", "/api/worlds/second-world"],
    ["PATCH", "/api/worlds/locked%2Dworld/"],
    ["POST", "/api/worlds/locked-world/status"],
    ["POST", "/api/worlds/locked-world/assets"],
    ["DELETE", "/api/worlds/locked-world/asset-refs/asset"],
    ["POST", "/api/worlds/locked-world/folder-bindings"],
    ["POST", "/api/worlds/locked-world/versions/version/restore"],
    ["POST", "/api/worlds/locked-world/updates"],
    ["POST", "/api/studio/locked-world/agent/start"],
    ["POST", "/api/studio/locked-world/agent/approve"],
    ["POST", "/api/studio/locked-world/rollback/snapshot"],
  ];
  for (const [method, path] of paths) {
    const response = await app.request(path!, { method });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json() as { code: string }).code, "WORLD_EDIT_LOCKED", path);
  }
  assert.equal(mutations, 0);
});

test("reading, playing, copying and unrelated cards stay available", async () => {
  const app = new Hono();
  app.use("/api/*", worldEditLockMiddleware);
  app.all("/api/*", c => c.json({ ok: true }));
  for (const [method, path] of [
    ["GET", "/api/worlds/locked-world"],
    ["GET", "/api/studio/locked-world/conversations"],
    ["POST", "/api/sessions"],
    ["POST", "/api/sessions/session/messages"],
    ["POST", "/api/worlds/locked-world/duplicate"],
    ["POST", "/api/worlds/locked-world/reviews"],
    ["PUT", "/api/worlds/locked-world/rating"],
    ["POST", "/api/studio/locked-world/agent/stop"],
    ["PATCH", "/api/worlds/another-world"],
  ]) assert.equal((await app.request(path!, { method })).status, 200, path);
});

test("linking an unlocked card cannot change a locked target", async () => {
  const app = new Hono();
  let handled = false;
  app.use("/api/*", worldEditLockMiddleware);
  app.post("/api/worlds/:id/link-language", async c => { handled = true; return c.json(await c.req.json()); });
  const response = await app.request("/api/worlds/another-world/link-language", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetWorldId: "locked-world" }),
  });
  assert.equal(response.status, 403);
  assert.equal(handled, false);
  const allowed = await app.request("/api/worlds/another-world/link-language", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetWorldId: "third-world" }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { targetWorldId: "third-world" });
});
