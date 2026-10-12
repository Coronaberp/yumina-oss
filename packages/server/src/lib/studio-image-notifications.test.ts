import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, generationJobs, studioConversations } from "../db/schema.js";
import { createStudioImageNotifications } from "./studio-image-notifications.js";
import { runAgentLoop } from "../routes/agent.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";

async function fixture(t: test.TestContext) {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID(), cid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Image notification QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {
    id: wid, version: "19.0.0", name: "QA", entries: [], variables: [], rules: [], reactions: [],
    components: [], audioTracks: [], customUI: [], settings: {},
  } });
  await db.insert(studioConversations).values({ id: cid, userId: uid, worldId: wid, title: "QA", messages: [] });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, conversationId: cid,
    status: "completed", model: "test-model", messages: [{ role: "user", content: "Make her happy" }, { role: "assistant", content: "The image is queued." }] });
  t.after(() => db.delete(user).where(eq(user.id, uid)));
  const addJob = async (status: "succeeded" | "failed" | "cancelled" = "succeeded", notifyAgent = true) => {
    const [job] = await db.insert(generationJobs).values({ userId: uid, kind: "image", templateId: "studio-configured-image", provider: "codex",
      status, costMushies: 0, refundAmount: 0, completedAt: new Date(), assetIds: status === "succeeded" ? [crypto.randomUUID()] : [],
      errorMessage: status === "failed" ? "Image provider unavailable" : null,
      params: { worldId: wid, runId: rid, conversationId: cid, notifyAgent, proposal: { prompt: "Make her happy", purpose: "Happy expression" } } }).returning();
    return job!;
  };
  const launches: Array<{ runId: string; messages: unknown; model: string }> = [];
  const service = createStudioImageNotifications(async params => { launches.push(params); }, async () => ({
    model: "test-model", provider: {} as any, isByok: true, apiKeyTier: "byok" as const,
  }));
  return { uid, wid, rid, addJob, launches, service };
}

test("a settled image starts a fresh notified agent turn exactly once without waiting", async t => {
  const f = await fixture(t), job = await f.addJob();
  await Promise.all([f.service.notify(f.uid, f.wid, f.rid), f.service.notify(f.uid, f.wid, f.rid)]);
  assert.equal(f.launches.length, 1);
  assert.notEqual(f.launches[0]!.runId, f.rid);
  assert.match(JSON.stringify(f.launches[0]!.messages), /Image generation notification.*succeeded/);
  assert.match(JSON.stringify(f.launches[0]!.messages), new RegExp(job.assetIds![0]!));
  assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, f.rid)))[0]!.status, "completed");
  await f.service.notify(f.uid, f.wid, f.rid);assert.equal(f.launches.length, 1);
});

test("completion while the agent is running is delivered after its turn ends", async t => {
  const f = await fixture(t);await f.addJob();
  await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, f.rid));
  await f.service.notify(f.uid, f.wid, f.rid);assert.equal(f.launches.length, 0);
  await db.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, f.rid));
  await f.service.notify(f.uid, f.wid, f.rid);assert.equal(f.launches.length, 1);
});

test("failed images notify the agent with the actual failure and no saved refs", async t => {
  const f = await fixture(t);await f.addJob("failed");
  await f.service.notify(f.uid, f.wid, f.rid);
  assert.equal(f.launches.length, 1);assert.match(JSON.stringify(f.launches[0]!.messages), /Image provider unavailable/);
  assert.doesNotMatch(JSON.stringify(f.launches[0]!.messages), /@asset:/);
});

test("a second image finishing during the notified turn starts one further turn after it ends", async t => {
  const f = await fixture(t);await f.addJob();
  await f.service.notify(f.uid, f.wid, f.rid);
  const first = f.launches[0]!.runId;
  const second = await f.addJob();
  await f.service.notify(f.uid, f.wid, f.rid);assert.equal(f.launches.length, 1);
  await db.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, first));
  await f.service.notify(f.uid, f.wid, f.rid);
  assert.equal(f.launches.length, 2);
  assert.match(JSON.stringify(f.launches[1]!.messages), new RegExp(second.id));
});

test("a notification uses the real agent lifecycle and persists its answer without a browser", async t => {
  const f = await fixture(t);await f.addJob("failed");
  await db.update(agentRuns).set({ messages: [{ role: "user", content: "Make her happy" },
    { role: "assistant", content: "", tool_calls: [{ id: "old-image-task-read", type: "function", function: { name: "read_entities", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "old-image-task-read", content: "{}" }, { role: "assistant", content: "The image is queued." }] })
    .where(eq(agentRuns.id, f.rid));
  const events: Array<{ event: string; data: string }> = [];
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const provider = { listModels: async () => [], async *generateStream(params: GenerateParams): AsyncGenerator<StreamChunk> {
    assert.match(JSON.stringify(params.messages), /Image generation notification/);
    yield { type: "text", content: "The image failed: Image provider unavailable. No image was saved." };
    yield { type: "done", content: "", stopReason: "end_turn" };
  } } as any;
  const service = createStudioImageNotifications(async params => {
    try { await runAgentLoop({ ...params, tools: [], unlimited: true }, { writeSSE: async event => { events.push(event); }, onAbort: () => {} }); }
    finally { finished(); }
  }, async () => ({ model: "test-model", provider, isByok: true, apiKeyTier: "byok" }));
  await service.notify(f.uid, f.wid, f.rid);await done;
  assert.ok(events.some(event => event.event === "assistant_turn_commit" && event.data.includes("Image provider unavailable")), JSON.stringify(events));
  const started = JSON.parse(events.find(event => event.event === "run_started")!.data).runId;
  const [saved] = await db.select().from(agentRuns).where(eq(agentRuns.id, started));
  assert.equal(saved!.status, "completed");assert.match(JSON.stringify(saved!.committedTurns), /No image was saved/);
  assert.doesNotMatch(JSON.stringify(events.filter(event => event.event === "tool_trace")), /old-image-task-read/,
    "The notification must not claim the original turn's tools ran again");
});

test("stop, newer user work, cancellation, old jobs and foreign owners never resurrect a task", async t => {
  for (const reason of ["stop", "newer", "cancelled", "historical", "foreign"]) {
    const f = await fixture(t);await f.addJob(reason === "cancelled" ? "cancelled" : "succeeded", reason !== "historical");
    if (reason === "stop") await db.update(agentRuns).set({ error: "Stopped by user." }).where(eq(agentRuns.id, f.rid));
    if (reason === "newer") await db.insert(agentRuns).values({ userId: f.uid, worldId: f.wid, model: "test-model", status: "completed", createdAt: new Date(Date.now() + 1000) });
    await f.service.notify(reason === "foreign" ? "foreign" : f.uid, f.wid, f.rid);
    assert.equal(f.launches.length, 0, reason);
  }
});
