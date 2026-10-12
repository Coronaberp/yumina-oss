import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, ensureContentFlags } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { contentFlagRoutes } from "./content-flags.js";
import { contentFlagService, createContentFlagService } from "../lib/content-flag-service.js";
import { createPendingContentFlags } from "../lib/content-flag-policy.js";
import type { AppEnv } from "../lib/types.js";
import type { ContentFlagInspection } from "@yumina/shared";

test("only the session owner can inspect or retry server-owned flags", async t => {
  await ensureContentFlags();
  const uid = crypto.randomUUID(), wid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Flags QA", email: `${uid}@example.test` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "Flags QA", schema: {} });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: wid }).returning();
  const [input] = await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "Private input", createdAt: new Date("2026-10-04T01:00:00Z") }).returning();
  await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Private reply", createdAt: new Date("2026-10-04T01:00:01Z"), swipes: [{ content: "Private reply", choices: ["Choose a book"], createdAt: "2026-10-04T01:00:01Z" }] });
  const service = createContentFlagService(db, { classify: async (role, content, choices) => ({ ...createPendingContentFlags(role, content, choices), status: "complete", label: "sfw", routingSafe: true, completedAt: new Date().toISOString(), nsfwProbability: .01, sfwProbability: .99, model: "test", device: "cpu" }) });
  t.after(() => service.stop());
  let actor: string = uid;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: actor } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of contentFlagRoutes.routes.filter(row => ["GET", "POST"].includes(row.method))) app.on(route.method, route.path, route.handler);
  const target = `/sessions/${session!.id}/content-flags`;
  const inspect = async () => await (await app.request(target)).json() as { data: ContentFlagInspection };
  const post = (body: unknown) => app.request(`${target}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await t.test("pending input and output cannot mark the turn SFW", async () => {
    const response = await app.request(target), body = await response.json() as { data: ContentFlagInspection };
    assert.equal(response.status, 200); assert.equal(body.data.turn.label, "nsfw");
    assert.equal(body.data.threshold, .4); assert.equal(body.data.messages.length, 2);
    assert.equal(JSON.stringify(body).includes("Private"), false);
  });
  await t.test("valid flags require BOTH input and reply and current hashes", async () => {
    await service.recover(); await service.waitForIdle();
    assert.equal((await inspect()).data.turn.label, "sfw");
    await db.update(messages).set({ content: "Edited input" }).where(eq(messages.id, input!.id));
    assert.equal((await inspect()).data.turn.label, "nsfw");
  });
  await t.test("cross-owner reads and writes reveal no audit and schedule no check", async () => {
    actor = "someone-else";
    assert.equal((await app.request(target)).status, 404);
    assert.equal((await post({ messageId: input!.id })).status, 404);
    actor = uid;
  });
  await t.test("flags cannot be supplied by the client and retries do not alter story text", async () => {
    assert.equal((await post({ messageId: input!.id, label: "sfw" })).status, 400);
    const queued: string[] = [];
    t.mock.method(contentFlagService, "enqueue", (id: string) => { queued.push(id); return true; });
    const response = await post({ messageId: input!.id });
    assert.equal(response.status, 202); assert.deepEqual(queued, [input!.id]);
    assert.equal((await db.select().from(messages).where(eq(messages.id, input!.id)))[0]!.content, "Edited input");
  });
  await t.test("a new input cannot reuse a previous reply's safe turn", async () => {
    await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "Next turn", createdAt: new Date("2026-10-04T01:00:02Z") });
    await service.recover(); await service.waitForIdle();
    const body = await inspect();
    assert.equal(body.data.turn.label, "nsfw"); assert.equal(body.data.turn.outputMessageId, null);
  });
});
