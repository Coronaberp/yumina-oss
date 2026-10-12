import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, ensureContentFlags, ensureStoryhavenMemoryTables } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import { createContentFlagService, currentContentFlag, contentFlagTurn } from "./content-flag-service.js";
import { createPendingContentFlags } from "./content-flag-policy.js";
import type { ContentFlagAudit } from "@yumina/shared";

function safe(role: "user" | "assistant" | "system", content: string, choices: readonly string[] = []): ContentFlagAudit {
  return { ...createPendingContentFlags(role, content, choices), status: "complete", label: "sfw", routingSafe: true, completedAt: new Date().toISOString(), nsfwProbability: .01, sfwProbability: .99, model: "jaredpalmer/kev-0.8b", device: "cpu" };
}

test("content flags persist, recover, and follow visible variants without changing story state", async t => {
  await ensureContentFlags();
  await ensureStoryhavenMemoryTables();
  const uid = crypto.randomUUID(), wid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Flags QA", email: `${uid}@example.test` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "Flags QA", schema: {} });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: wid, state: { variables: { trust: 3 } } }).returning();
  const sid = session!.id;
  const read = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
  const [input] = await db.insert(messages).values({ sessionId: sid, role: "user", content: "Hello" }).returning();
  const [reply] = await db.insert(messages).values({ sessionId: sid, role: "assistant", content: "Welcome", swipes: [{ content: "Welcome", choices: ["Read a book"], createdAt: new Date().toISOString() }] }).returning();
  const classifier = { classify: async (role: "user" | "assistant" | "system", body: string, choices: readonly string[] = []) => safe(role, body, choices) };
  const service = createContentFlagService(db, classifier);
  t.after(() => service.stop());
  await t.test("new input and authored replies are immediately pending and unsafe", async () => {
    for (const row of [await read(input!.id), await read(reply!.id)]) {
      assert.equal(row.contentFlags?.status, "pending");
      assert.equal(row.contentFlags?.routingSafe, false);
    }
  });
  await t.test("bounded recovery classifies persisted pending records after startup", async () => {
    const before = (await db.execute(sql`SELECT epoch, version FROM storyhaven_memory_sessions WHERE session_id=${sid}`)).rows;
    await service.recover(); await service.waitForIdle();
    assert.equal((await read(input!.id)).contentFlags?.label, "sfw");
    const row = await read(reply!.id);
    assert.equal(row.contentFlags?.label, "sfw");
    assert.deepEqual(row.contentFlags, row.swipes?.[0]?.contentFlags);
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, sid)))[0]!.state, { variables: { trust: 3 } });
    assert.deepEqual((await db.execute(sql`SELECT epoch, version FROM storyhaven_memory_sessions WHERE session_id=${sid}`)).rows, before, "flag-only writes must not invalidate memory");
  });
  await t.test("recovery replaces outdated completed and errored audits with whole-message checks", async () => {
    for (const status of ["complete", "error"] as const) {
      const old = { ...safe("user", "Hello"), policyId: "kev-strict-v1" as const, status, ...(status === "error" ? { errorCode: "classifier_inference_failed" } : {}) };
      await db.update(messages).set({ contentFlags: old }).where(eq(messages.id, input!.id));
      assert.equal(currentContentFlag(await read(input!.id)), null);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const recovering = createContentFlagService(db, { classify: async (role, content, choices) => { entered(); await gate; return safe(role, content, choices); } });
      await recovering.recover();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Outdated flag was never requeued")), 2000); })]);
      } finally { if (timeout) clearTimeout(timeout); }
      const pending = await read(input!.id);
      assert.equal(pending.contentFlags?.status, "pending");
      assert.equal(pending.contentFlags?.policyId, "kev-whole-message-v4");
      release(); await recovering.waitForIdle(); recovering.stop();
      assert.equal((await read(input!.id)).contentFlags?.policyId, "kev-whole-message-v4");
      assert.equal((await read(input!.id)).contentFlags?.status, "complete");
    }
  });
  await t.test("selecting an old checked swipe requeues that visible response without changing its text or choices", async () => {
    const row = await read(reply!.id);
    const old = { ...safe("assistant", row.content, row.swipes![0]!.choices), policyId: "kev-strict-v1" as const };
    await db.update(messages).set({ swipes: [{ ...row.swipes![0]!, contentFlags: old }] }).where(eq(messages.id, row.id));
    assert.equal((await read(row.id)).contentFlags?.policyId, "kev-strict-v1");
    assert.equal(currentContentFlag(await read(row.id)), null);
    await service.recover(); await service.waitForIdle();
    const checked = await read(row.id);
    assert.equal(checked.contentFlags?.policyId, "kev-whole-message-v4");
    assert.equal(checked.contentFlags?.status, "complete");
    assert.deepEqual(checked.swipes![0]!.contentFlags, checked.contentFlags);
    assert.equal(checked.content, row.content);
    assert.deepEqual(checked.swipes![0]!.choices, row.swipes![0]!.choices);
  });
  await t.test("a displayed SFW turn needs two strong certificates to be routing eligible", async () => {
    const inputRow = await read(input!.id), outputRow = await read(reply!.id);
    const strongInput = { ...inputRow, contentFlags: safe("user", inputRow.content) };
    const strongOutput = { ...outputRow, status: "complete" as const, contentFlags: safe("assistant", outputRow.content, outputRow.swipes![0]!.choices) };
    assert.equal(contentFlagTurn([strongInput, strongOutput]).routingSafe, true);
    const uncertainOutput = { ...strongOutput, contentFlags: { ...strongOutput.contentFlags, nsfwProbability: .3766, sfwProbability: .6234, routingSafe: false } };
    const turn = contentFlagTurn([strongInput, uncertainOutput]);
    assert.equal(turn.label, "sfw"); assert.equal(turn.routingSafe, false);
  });
  await t.test("editing content or offered choices invalidates the old safe flag", async () => {
    await db.update(messages).set({ content: "Changed", swipes: [{ ...((await read(reply!.id)).swipes![0]!), content: "Changed" }] }).where(eq(messages.id, reply!.id));
    assert.equal((await read(reply!.id)).contentFlags?.status, "pending");
    await service.recover(); await service.waitForIdle();
    const row = await read(reply!.id);
    await db.update(messages).set({ swipes: [{ ...row.swipes![0]!, choices: ["A different action"] }] }).where(eq(messages.id, reply!.id));
    assert.equal((await read(reply!.id)).contentFlags?.status, "pending");
  });
  await t.test("regeneration is pending, selecting a checked variant restores only its own flag", async () => {
    await service.recover(); await service.waitForIdle();
    const row = await read(reply!.id), checked = row.contentFlags;
    await db.update(messages).set({ content: "Alternate", activeSwipeIndex: 1, swipes: [...row.swipes!, { content: "Alternate", createdAt: new Date().toISOString() }] }).where(eq(messages.id, reply!.id));
    assert.equal((await read(reply!.id)).contentFlags?.status, "pending");
    await db.update(messages).set({ content: "Changed", activeSwipeIndex: 0 }).where(eq(messages.id, reply!.id));
    assert.deepEqual((await read(reply!.id)).contentFlags, checked);
  });
  await t.test("a slow result cannot certify an edit made during inference", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    const delayed = createContentFlagService(db, { classify: async (role, body, choices) => { entered(); await gate; return safe(role, body, choices); } });
    await db.update(messages).set({ content: "First edit" }).where(eq(messages.id, input!.id));
    delayed.enqueue(input!.id); await started;
    await db.update(messages).set({ content: "Newer edit" }).where(eq(messages.id, input!.id));
    release(); await delayed.waitForIdle(); delayed.stop();
    const row = await read(input!.id);
    assert.equal(row.content, "Newer edit");
    assert.equal(row.contentFlags?.status, "pending");
    assert.equal(row.contentFlags?.routingSafe, false);
  });
  await t.test("completion for an inactive variant does not overwrite the selected audit", async () => {
    const row = await read(reply!.id), checked = row.contentFlags;
    await db.update(messages).set({ content: "Alternate", activeSwipeIndex: 1 }).where(eq(messages.id, row.id));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const delayed = createContentFlagService(db, { classify: async (role, body, choices) => { entered(); await gate; return safe(role, body, choices); } });
    delayed.enqueue(row.id); await started;
    await db.update(messages).set({ content: "Changed", activeSwipeIndex: 0 }).where(eq(messages.id, row.id));
    release(); await delayed.waitForIdle(); delayed.stop();
    const after = await read(row.id);
    assert.equal(after.activeSwipeIndex, 0);
    assert.deepEqual(after.contentFlags, checked);
    assert.equal(after.swipes![1]!.contentFlags?.status, "complete");
  });
  await t.test("failed workers record explicit errors and never label a turn safe", async () => {
    const failed = createContentFlagService(db, { classify: async () => { throw new Error("private story text must not leak"); } });
    failed.enqueue(input!.id); await failed.waitForIdle(); failed.stop();
    const row = await read(input!.id);
    assert.equal(row.contentFlags?.status, "error");
    assert.equal(row.contentFlags?.label, "nsfw");
    assert.equal(row.contentFlags?.routingSafe, false);
    assert.equal(row.contentFlags?.errorCode, "classifier_failed");
  });
  await t.test("player input is classified even when its story request failed", async () => {
    await db.update(messages).set({ content: "Still a submitted input", status: "failed" }).where(eq(messages.id, input!.id));
    await service.recover(); await service.waitForIdle();
    const row = await read(input!.id);
    assert.equal(row.status, "failed");
    assert.equal(row.contentFlags?.status, "complete");
    assert.equal(row.contentFlags?.label, "sfw");
  });
  await t.test("unfinished responses show an error, then become pending when completed", async () => {
    await db.update(messages).set({ status: "failed" }).where(eq(messages.id, reply!.id));
    const failed = await read(reply!.id);
    assert.equal(failed.contentFlags?.status, "error");
    assert.equal(failed.contentFlags?.errorCode, "incomplete_response");
    assert.equal(failed.contentFlags?.routingSafe, false);
    await db.update(messages).set({ status: "complete" }).where(eq(messages.id, reply!.id));
    assert.equal((await read(reply!.id)).contentFlags?.status, "pending");
    await service.recover(); await service.waitForIdle();
    assert.equal((await read(reply!.id)).contentFlags?.status, "complete");
  });
});
