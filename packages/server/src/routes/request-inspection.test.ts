import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { requestInspectionRoutes } from "./request-inspection.js";
import { createRequestCapture, requestReceipts } from "../lib/request-inspection.js";
import type { AppEnv } from "../lib/types.js";

test("inspection requires both recognized card ownership and that account's own session, without admin exceptions", async t => {
  const client = db.$client; assert.ok(client instanceof PGlite);
  t.after(async () => { await client.close(); });
  const owner = crypto.randomUUID(), player = crypto.randomUUID(), admin = crypto.randomUUID();
  for (const id of [owner, player, admin]) await db.insert(user).values({ id, name: id, email: `${id}@test.local`, role: id === admin ? "admin" : "user" });
  const original = crypto.randomUUID(), imported = crypto.randomUUID();
  await db.insert(worlds).values([
    { id: original, creatorId: player, name: "Original protected card", allowEdit: false, allowCustomApi: false, schema: {} },
    { id: imported, creatorId: owner, name: "Recognized imported owner", sourceWorldId: original, allowEdit: false, allowCustomApi: false, schema: {} },
  ]);
  const [ownSession] = await db.insert(playSessions).values({ userId: owner, worldId: imported, state: {} }).returning();
  const [playerSession] = await db.insert(playSessions).values({ userId: player, worldId: imported, state: {} }).returning();
  const [adminSession] = await db.insert(playSessions).values({ userId: admin, worldId: imported, state: {} }).returning();
  const [reply] = await db.insert(messages).values({ sessionId: ownSession!.id, role: "assistant", content: "reply", swipes: [{ content: "reply", createdAt: new Date().toISOString() }] }).returning();
  const [foreignReply] = await db.insert(messages).values({ sessionId: playerSession!.id, role: "assistant", content: "private player reply" }).returning();
  const capture = createRequestCapture();
  capture.onRequest({ provider: "custom", body: { model: "actual-wire", messages: [{ role: "system", content: "PRIVATE_REQUEST_MARKER" }] } });
  const scope = { userId: owner, worldId: imported, sessionId: ownSession!.id, messageId: reply!.id, swipeIndex: 0 };
  requestReceipts.put(scope, capture.finish("send"));
  let viewer: string | undefined = owner;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (viewer) c.set("user", { id: viewer, role: viewer === admin ? "admin" : "user" } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of requestInspectionRoutes.routes.filter(route => route.method === "GET")) app.get(route.path, route.handler);
  const read = async (response: Response) => response.json() as Promise<{ data: { allowed?: boolean; available?: boolean } }>;
  const access = (session = ownSession!.id) => app.request(`/sessions/${session}/request-inspection-access`);
  const receipt = (session = ownSession!.id, message = reply!.id, swipe = "0") => app.request(`/sessions/${session}/messages/${message}/request-inspection?swipe=${swipe}`);
  assert.equal((await read(await access())).data.allowed, true, "the recognized imported owner is accepted under the user's clarified policy");
  const allowed = await receipt();
  assert.match(allowed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(await allowed.text(), /PRIVATE_REQUEST_MARKER/);
  assert.equal((await receipt(ownSession!.id, foreignReply!.id)).status, 404);
  for (const swipe of ["-1", "1.2", "abc", "1000000000"]) assert.equal((await receipt(ownSession!.id, reply!.id, swipe)).status, 400);
  assert.equal((await receipt(ownSession!.id, reply!.id, "1")).status, 404);
  assert.equal((await receipt(playerSession!.id, foreignReply!.id)).status, 404, "card ownership grants no access to another player's session");
  for (const denied of [player, admin]) {
    viewer = denied;
    assert.equal((await read(await access())).data.allowed, false);
    const response = await receipt();
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /PRIVATE_REQUEST_MARKER|actual-wire/);
    assert.equal((await read(await access(denied === player ? playerSession!.id : adminSession!.id))).data.allowed, false, "owning a session alone is insufficient");
  }
  viewer = undefined;
  assert.equal((await receipt()).status, 401);
  viewer = owner;
  await db.update(worlds).set({ creatorId: admin }).where(eq(worlds.id, imported));
  assert.equal((await receipt()).status, 404, "access rechecks current ownership instead of trusting a cached grant");
  await db.update(worlds).set({ creatorId: owner }).where(eq(worlds.id, imported));
  const [oldReply] = await db.insert(messages).values({ sessionId: ownSession!.id, role: "assistant", content: "old" }).returning();
  const unavailable = await receipt(ownSession!.id, oldReply!.id);
  assert.equal(unavailable.status, 200);
  assert.equal((await read(unavailable)).data.available, false);
});
