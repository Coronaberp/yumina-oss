import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, userAssets, generationJobs } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { configuredImageJobs } from "../lib/configured-image-jobs.js";
import { imageGenerationService } from "../lib/image-generation/default.js";
import { agentRoutes } from "./agent.js";

test("stale image confirmation returns the saved automatic job without resuming or regenerating", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID(), aid = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Image replay QA", email: `${uid}@test.local` });
  await db.insert(user).values({ id: otherId, name: "Other owner", email: `${otherId}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna", status: "completed" });
  await db.insert(userAssets).values({ id: aid, userId: uid, type: "image", filename: "saved.png", url: `users/${uid}/saved.png` });
  const proposal = { source: "codex" as const, prompt: "Safe blue circle", imageKind: "image" as const,
    model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1" as const, batchSize: 1 };
  const job = await configuredImageJobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "picture-1", proposal });
  await db.update(generationJobs).set({ status: "succeeded", assetId: aid, assetIds: [aid], completedAt: new Date() }).where(eq(generationJobs.id, job.jobId));
  let actorId = uid;
  t.mock.method(auth.api, "getSession", async () => ({ user: { id: actorId }, session: { id: "fixture", userId: actorId, expiresAt: new Date(Date.now() + 60_000), token: "fixture" } }));
  let generations = 0;
  t.mock.method(imageGenerationService, "generate", async () => { generations++;throw new Error("No new generation"); });
  const request = (body: unknown, worldId = wid) => agentRoutes.request(`/${worldId}/agent/generate-image`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const body of [{ runId: rid, approved: true, prompt: proposal.prompt },
      { runId: rid, toolCallId: "picture-1", approved: true },
      { runId: rid, toolCallId: "picture-1", approved: true, prompt: "Edits made after the image already started" }]) {
      const response = await request(body);
      assert.equal(response.status, 200);
      const events = await response.text();
      assert.match(events, /event: image_result/);assert.match(events, /"status":"done"/);
      assert.ok(events.includes(aid));assert.ok(events.includes(job.jobId));assert.doesNotMatch(events, /event: error/);
      assert.match(events, /"proposal":\{/);assert.ok(events.includes(proposal.prompt));
    }
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "completed");
    assert.equal((await db.select().from(generationJobs).where(eq(generationJobs.userId, uid))).length, 1);
    assert.equal(generations, 0);
    assert.equal((await request({ runId: rid, toolCallId: "foreign-call", approved: true })).status, 404);
    const foreignWorld = await request({ runId: rid, approved: true }, crypto.randomUUID());
    assert.equal(foreignWorld.status, 404);assert.ok(!(await foreignWorld.text()).includes(aid));
    actorId = otherId;
    const foreignOwner = await request({ runId: rid, toolCallId: "picture-1", approved: true });
    assert.equal(foreignOwner.status, 404);assert.ok(!(await foreignOwner.text()).includes(aid));
    actorId = uid;

    await db.update(agentRuns).set({ status: "running", iteration: 3 }).where(eq(agentRuns.id, rid));
    const activeReplay = await request({ runId: rid, toolCallId: "picture-1", approved: true });
    assert.equal(activeReplay.status, 200);
    assert.doesNotMatch(await activeReplay.text(), /event: done/, "An image result must not declare the main agent finished");
    const [active] = await db.select().from(agentRuns).where(eq(agentRuns.id, rid));
    assert.equal(active!.status, "running");assert.equal(active!.iteration, 3);

    const queued = await configuredImageJobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "picture-2", proposal });
    const ambiguous = await request({ runId: rid, approved: true, prompt: proposal.prompt });
    assert.equal(ambiguous.status, 409);assert.equal((await ambiguous.json() as { code: string }).code, "IMAGE_JOB_AMBIGUOUS");
    const cancelled = await request({ runId: rid, toolCallId: "picture-2", approved: false });
    assert.equal(cancelled.status, 200);assert.match(await cancelled.text(), /USER_CANCELLED/);
    assert.equal((await configuredImageJobs.get(uid, queued.jobId))!.status, "cancelled");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "running");
    await db.update(agentRuns).set({ status: "awaiting_approval", pendingToolCalls: [{ id: "current-pending", type: "function",
      function: { name: "generate_image", arguments: JSON.stringify(proposal) } }] }).where(eq(agentRuns.id, rid));
    const staleCall = await request({ runId: rid, toolCallId: "different-pending", approved: true });
    assert.equal(staleCall.status, 409);assert.equal((await staleCall.json() as { code: string }).code, "NOT_IMAGE_PROPOSAL");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "awaiting_approval");
    assert.equal(generations, 0);

    // Stop wins if it finishes while the stale-card rollback waits for storage.
    const realUpdate = db.update.bind(db);
    t.mock.method(db, "update", (table: Parameters<typeof db.update>[0]) => {
      const builder = realUpdate(table);
      return new Proxy(builder, { get(target, property) {
        if (property !== "set") return Reflect.get(target, property);
        return (...args: Parameters<typeof builder.set>) => {
          const stage = target.set(...args);
          if (table !== agentRuns || (args[0] as { status?: unknown }).status !== "awaiting_approval") return stage;
          return new Proxy(stage, { get(pending, key) {
            if (key !== "where") return Reflect.get(pending, key);
            return (...conditions: Parameters<typeof stage.where>) => {
              const query = pending.where(...conditions);
              return new Proxy(query, { get(statement, method) {
                if (method !== "then") return Reflect.get(statement, method);
                return async (...handlers: unknown[]) => {
                  await realUpdate(agentRuns).set({ status: "completed", error: "Stopped by user" }).where(eq(agentRuns.id, rid));
                  return Reflect.apply(statement.then, statement, handlers);
                };
              } });
            };
          } });
        };
      } });
    });
    const stoppedRace = await request({ runId: rid, toolCallId: "different-pending", approved: false });
    assert.equal(stoppedRace.status, 409);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "completed");
  } finally { await db.delete(user).where(eq(user.id, uid));await db.delete(user).where(eq(user.id, otherId)); }
});
