import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, userAssets, worlds, agentRuns, generationJobs } from "../db/schema.js";
import { createConfiguredImageJobs } from "./configured-image-jobs.js";
import { GenerationError, type GeneratedAsset } from "./image-generation/config.js";

test("approved image queues immediately, continues independently, and replay never generates twice", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID(), aid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Background image QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  let finish!: (image: GeneratedAsset) => void, generations = 0;
  const jobs = createConfiguredImageJobs(async (_user, input) => {
    generations++; assert.equal(input.provider, "codex");assert.ok(input.signal);
    return new Promise<GeneratedAsset>(resolve => { finish = resolve; });
  });
  t.after(async () => { jobs.stop();await jobs.drain(100);await db.delete(user).where(eq(user.id, uid)); });
  const options = { userId: uid, worldId: wid, runId: rid, callId: "image-1", proposal: { source: "codex" as const,
    prompt: "Safe gold star", imageKind: "sprite" as const, model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1" as const, batchSize: 1 } };
  const first = await jobs.submit(options);
  assert.equal(first.status, "queued");
  assert.equal((await jobs.submit(options)).jobId, first.jobId);
  await jobs.tick();
  assert.equal((await jobs.get(uid, first.jobId))!.status, "running");
  assert.equal(generations, 1, "The worker continues after submission returns");
  assert.equal(await jobs.get("another-owner", first.jobId), null);
  await db.insert(userAssets).values({ id: aid, userId: uid, type: "image", filename: "star.png", url: `users/${uid}/star.png` });
  finish({ id: aid, ref: `@asset:${aid}`, filename: "star.png", source: { provider: "codex", imageKind: "sprite", prompt: "Safe gold star", createdAt: new Date().toISOString(), greenRemoved: false, attribution: "QA" } });
  await jobs.drain(1000);
  const saved = (await jobs.get(uid, first.jobId))!;
  assert.equal(saved.status, "succeeded");assert.deepEqual(saved.refs, [`@asset:${aid}`]);
  assert.equal((await jobs.submit(options)).jobId, first.jobId);await jobs.tick();assert.equal(generations, 1);
  assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "running", "Image completion never changes or restarts the main agent");
});

test("NSFW image rejection persists as a failed job with no output", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Refusal QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  const jobs = createConfiguredImageJobs(async () => { throw new Error("Image generation is disabled for NSFW requests. No image was generated."); });
  t.after(async () => { jobs.stop();await db.delete(user).where(eq(user.id, uid)); });
  const submitted = await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "blocked", proposal: {
    source: "codex", prompt: "Rejected request", imageKind: "image", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1", batchSize: 1 } });
  await jobs.tick();await jobs.drain(1000);
  const result = (await jobs.get(uid, submitted.jobId))!;
  assert.equal(result.status, "failed");assert.equal(result.errorCode, "NSFW_IMAGE_REQUEST");assert.deepEqual(result.assetIds, []);
});

test("cancelling a running image aborts its worker, and cancelling queued work prevents any generation", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Cancel QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  let signal: AbortSignal | undefined, calls = 0;
  const jobs = createConfiguredImageJobs(async (_user, input) => {
    signal = input.signal;calls++;
    return new Promise<never>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
  });
  t.after(async () => { jobs.stop();await db.delete(user).where(eq(user.id, uid)); });
  const options = { userId: uid, worldId: wid, runId: rid, callId: "running", proposal: {
    source: "codex" as const, prompt: "Safe star", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1" as const, batchSize: 1 } };
  const running = await jobs.submit(options);await jobs.tick();
  const queued = await jobs.submit({ ...options, callId: "queued" });
  assert.equal(await jobs.cancel("foreign", running.jobId, wid), null);
  assert.equal((await jobs.cancel(uid, queued.jobId, wid))!.status, "cancelled");
  assert.equal((await jobs.cancel(uid, running.jobId, wid))!.status, "cancelled");
  assert.equal(signal!.aborted, true);await jobs.drain(1000);await jobs.tick();
  assert.equal(calls, 1);assert.equal((await jobs.get(uid, running.jobId))!.status, "cancelled");
  assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "running");
});

test("cancelling after the image save committed returns the finished picture instead of hiding it", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID(), aid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Late cancel QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  await db.insert(userAssets).values({ id: aid, userId: uid, type: "image", filename: "saved.png", url: `users/${uid}/saved.png` });
  const jobs = createConfiguredImageJobs(async () => assert.fail("No replacement generation"));
  t.after(async () => { jobs.stop();await db.delete(user).where(eq(user.id, uid)); });
  const submitted = await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "saved", proposal: {
    source: "codex", prompt: "Safe star", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1", batchSize: 1 } });
  const [row] = await db.update(generationJobs).set({ status: "running" }).where(eq(generationJobs.id, submitted.jobId)).returning();
  await db.execute(sql`INSERT INTO image_generation_requests(user_id,request_id,state,asset_id) VALUES(${uid},${String(row!.params.requestId)},'succeeded',${aid})`);
  const result = await jobs.cancel(uid, submitted.jobId, wid);
  assert.equal(result!.status, "succeeded");assert.deepEqual(result!.refs, [`@asset:${aid}`]);
  assert.equal((await jobs.get(uid, submitted.jobId))!.status, "succeeded");
});

test("one creator fans out four independent image workers and cancelling one leaves the others drawing", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Fan out QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  const calls: Array<{ requestId?: string; signal: AbortSignal }> = [];
  const jobs = createConfiguredImageJobs(async (_user, input) => {
    calls.push({ requestId: input.requestId, signal: input.signal! });
    return new Promise<never>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
  });
  const submitted: Array<Awaited<ReturnType<typeof jobs.submit>>> = [];
  t.after(async () => { jobs.stop();for (const job of submitted) await jobs.cancel(uid, job.jobId, wid);await jobs.drain(1000);await db.delete(user).where(eq(user.id, uid)); });
  for (let index = 0; index < 5; index++) submitted.push(await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: `image-${index}`, proposal: {
    source: "codex", prompt: `Safe circle ${index}`, imageKind: "image", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1", batchSize: 1 } }));
  await jobs.tick();assert.equal(calls.length, 4, "All four providers start before any finishes");
  assert.equal(new Set(calls.map(call => call.requestId)).size, 4);
  assert.equal((await jobs.get(uid, submitted[4]!.jobId))!.status, "queued");
  await jobs.cancel(uid, submitted[1]!.jobId, wid);await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1]!.signal.aborted, true);assert.equal(calls[0]!.signal.aborted, false);assert.equal(calls[2]!.signal.aborted, false);
  await jobs.tick();assert.equal(calls.length, 5, "The waiting image uses the released slot");
  assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!.status, "running");
});

test("Codex admission limits keep an image queued without resubmitting before its delay or after cancellation", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Admission QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  let attempts = 0;
  const jobs = createConfiguredImageJobs(async () => { attempts++;throw new GenerationError("GENERATION_BUSY", "No provider submission", 429); });
  t.after(async () => { jobs.stop();await jobs.drain(1000);await db.delete(user).where(eq(user.id, uid)); });
  const submitted = await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "waiting", proposal: {
    source: "codex", prompt: "Safe circle", imageKind: "image", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1", batchSize: 1 } });
  await jobs.tick();await jobs.drain(1000);
  assert.equal((await jobs.get(uid, submitted.jobId))!.status, "queued");
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, submitted.jobId));
  assert.ok(Number(row!.params.notBefore) > Date.now());assert.equal(row!.startedAt, null);
  await jobs.tick();assert.equal(attempts, 1);
  await jobs.cancel(uid, submitted.jobId, wid);
  await db.update(generationJobs).set({ params: { ...row!.params, notBefore: 0 } }).where(eq(generationJobs.id, submitted.jobId));
  await jobs.tick();assert.equal(attempts, 1);assert.equal((await jobs.get(uid, submitted.jobId))!.status, "cancelled");
});

test("Anima checkpoint choice is owner-checked and only editable during the queued preparation window", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Anima model QA", email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
  await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  const jobs = createConfiguredImageJobs(async () => assert.fail("Preparation should hold the image"));
  t.after(async () => { jobs.stop();await db.delete(user).where(eq(user.id, uid)); });
  const submitted = await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: "anima-choice", proposal: {
    source: "comfyui", animaEnabled: true, animaModel: "anima-base-v1.0.safetensors", prompt: "A student", imageKind: "sprite",
    model: "ComfyUI", aspectRatio: "1:1", batchSize: 1 } });
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.animaModelEditable, true);
  const replacement = "raehoshiAnima_v20_3182762.safetensors";
  const changed = await jobs.setAnimaModel(uid, submitted.jobId, wid, replacement, ["anima-base-v1.0.safetensors", replacement]);
  assert.equal(changed!.animaModel, replacement);
  assert.equal(await jobs.setAnimaModel("other-owner", submitted.jobId, wid, replacement, [replacement]), null);
  assert.equal(await jobs.setAnimaModel(uid, submitted.jobId, wid, "unknown-anima.safetensors", [replacement]), null);
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, submitted.jobId));
  await db.update(generationJobs).set({ params: { ...row!.params, preparationUntil: Date.now() - 1 } }).where(eq(generationJobs.id, submitted.jobId));
  assert.equal((await jobs.setAnimaModel(uid, submitted.jobId, wid, replacement, [replacement]))!.animaModelEditable, false);
});

test("ComfyUI jobs are limited to one active GPU workflow across creators", async t => {
  const identities = Array.from({ length: 2 }, () => ({ uid: crypto.randomUUID(), wid: crypto.randomUUID(), rid: crypto.randomUUID() }));
  for (const [index, { uid, wid, rid }] of identities.entries()) {
    await db.insert(user).values({ id: uid, name: `Comfy owner ${index}`, email: `${uid}@test.local` });
    await db.insert(worlds).values({ id: wid, creatorId: uid, name: "QA", status: "draft", schema: {} });
    await db.insert(agentRuns).values({ id: rid, userId: uid, worldId: wid, model: "codex/gpt-6-luna" });
  }
  const started: string[] = [];
  const jobs = createConfiguredImageJobs(async (_user, input) => {
    started.push(input.requestId!);
    return new Promise<never>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
  });
  const submitted: Array<Awaited<ReturnType<typeof jobs.submit>>> = [];
  t.after(async () => { jobs.stop();for (const [index, { uid, wid }] of identities.entries()) if (submitted[index]) await jobs.cancel(uid, submitted[index]!.jobId, wid);await jobs.drain(1000);for (const { uid } of identities) await db.delete(user).where(eq(user.id, uid)); });
  for (const [index, { uid, wid, rid }] of identities.entries()) submitted.push(await jobs.submit({ userId: uid, worldId: wid, runId: rid, callId: `comfy-${index}`, proposal: {
    source: "comfyui", prompt: "Character", imageKind: "sprite", model: "ComfyUI", aspectRatio: "1:1", batchSize: 1 } }));
  await jobs.tick();
  assert.equal(started.length, 1);
  assert.equal(submitted.filter((job, index) => job.status === "queued" && index === 1).length, 1);
});
