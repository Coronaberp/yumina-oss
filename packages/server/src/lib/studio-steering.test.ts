import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, and, sql } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, studioConversations, agentRuns } from "../db/schema.js";
import { enqueueStudioSteering, consumeStudioSteering, readStudioSteering, STUDIO_STEERING_KEY, StudioSteeringError, type StudioSteeringScope } from "./studio-steering.js";
import { captureStudioCreditWorldRevision, withStudioCreditClaimTransaction, readStudioCreditCheckpoint, type StudioCreditCheckpoint } from "./studio-credit-checkpoint.js";
import { loadStudioConversationForDisplay, loadAgentHistoryForConversation, serverOwnedStudioRunsToAgentHistory, withStudioUserMessageContext, applyStudioCompactionHistory } from "./studio-conversations.js";
import { estimateStudioTokens } from "./studio-context-compaction.js";
import { streamAgentLoop } from "../routes/agent.js";
import { STUDIO_TOOLS } from "./studio-tools/tools.js";
import type { ChatMessage, LLMProvider } from "./llm/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const errorCode = (code: string) => (error: unknown) => error instanceof StudioSteeringError && error.code === code;
const transcript = (): ChatMessage[] => [
  { role: "user", content: "Keep the custom resolver" },
  { role: "assistant", content: "Reading the source", tool_calls: [
    { id: "read-one", type: "function", function: { name: "read_entities", arguments: "{}" } },
    { id: "read-two", type: "function", function: { name: "read_entities", arguments: "{}" } },
  ] },
  { role: "tool", tool_call_id: "read-one", content: "Source one" },
  { role: "tool", tool_call_id: "read-two", content: "Source two" },
];
function assertToolPairing(messages: ChatMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    let owner = index - 1;
    while (owner >= 0 && messages[owner]!.role === "tool") owner--;
    const assistant = messages[owner];
    assert.ok(assistant?.role === "assistant" && assistant.tool_calls?.some(call => call.id === message.tool_call_id));
  }
}

describe("durable Studio steering", () => {
  let scope: StudioSteeringScope;
  let foreignUserId: string, otherWorldId: string, otherConversationId: string;
  let world: WorldDefinition;
  beforeEach(async () => {
    const userId = crypto.randomUUID(), worldId = crypto.randomUUID(), runId = crypto.randomUUID(), conversationId = crypto.randomUUID();
    foreignUserId = crypto.randomUUID(); otherWorldId = crypto.randomUUID(); otherConversationId = crypto.randomUUID();
    scope = { userId, worldId, runId, conversationId };
    world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Steering fixture", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
    await db.insert(user).values([{ id: userId, name: "Steering owner", email: `${userId}@test.local` }, { id: foreignUserId, name: "Other owner", email: `${foreignUserId}@test.local` }]);
    await db.insert(worlds).values([{ id: worldId, creatorId: userId, name: world.name, schema: world as unknown as Record<string, unknown>, status: "draft" }, { id: otherWorldId, creatorId: userId, name: "Other world", schema: world as unknown as Record<string, unknown>, status: "draft" }]);
    await db.insert(studioConversations).values([{ id: conversationId, userId, worldId, title: "Active chat", messages: [{ id: "initial-user", role: "user", content: "Original task" }] }, { id: otherConversationId, userId, worldId: otherWorldId, title: "Other chat" }]);
    await db.insert(agentRuns).values({ id: runId, userId, worldId, conversationId, status: "running", model: "steering-test", context: withStudioUserMessageContext({ activePanel: "entries" }, { role: "user", content: "Original task" }) });
  });
  afterEach(async () => {
    await db.delete(user).where(eq(user.id, scope.userId));
    await db.delete(user).where(eq(user.id, foreignUserId));
  });
  it("queues an uploaded image for the next step and preserves the actual visual input", async () => {
    const upload = { key: `studio-chat/${scope.userId}/12345678-1234-1234-1234-123456789abc.png`,
      url: "https://untrusted.example/wrong.png", name: "reference.png", mimeType: "image/png" };
    const queued = await enqueueStudioSteering(scope, "queued-image", "Use this image as my reference.", [upload]);
    assert.equal(queued.attachments?.length, 1);
    assert.doesNotMatch(queued.attachments![0]!.url, /untrusted/);
    const consumed = consumeStudioSteering({ [STUDIO_STEERING_KEY]: [queued] }, transcript(), 1);
    const message = consumed.messages.at(-1)!;
    assert.equal(message.role, "user");assert.ok(Array.isArray(message.content));
    assert.equal((message.content as any[]).filter(part => part.type === "image_url").length, 1);
    await assert.rejects(enqueueStudioSteering(scope, "foreign-image", "Use this", [{ ...upload, key: `studio-chat/${foreignUserId}/12345678-1234-1234-1234-123456789abc.png` }]), /own uploaded/);
  });
  const getRun = async () => (await db.select().from(agentRuns).where(eq(agentRuns.id, scope.runId)))[0]!;

  it("deduplicates retries and rejects reused IDs with changed content", async () => {
    const first = await enqueueStudioSteering(scope, "request-one", "  Preserve entity-42  ");
    assert.deepEqual(await enqueueStudioSteering(scope, "request-one", "Preserve entity-42"), first);
    await assert.rejects(enqueueStudioSteering(scope, "request-one", "Change entity-42"), errorCode("STEERING_ID_CONFLICT"));
    const run = await getRun();
    assert.equal(run.status, "running");
    assert.equal(readStudioSteering(run.context).length, 1);
    assert.equal(run.context?.activePanel, "entries");
    assert.deepEqual(run.messages, [], "Enqueue must not overwrite the worker's transcript mid-step");
  });

  it("checks owner, world, run and exact conversation scope", async () => {
    for (const wrong of [{ ...scope, userId: foreignUserId }, { ...scope, worldId: otherWorldId }, { ...scope, runId: crypto.randomUUID() }, { ...scope, conversationId: otherConversationId }, { ...scope, conversationId: null }]) {
      await assert.rejects(enqueueStudioSteering(wrong, "wrong-scope", "Correction"), errorCode("RUN_NOT_FOUND"));
    }
    assert.deepEqual(readStudioSteering((await getRun()).context), []);
    await db.update(agentRuns).set({ conversationId: null }).where(eq(agentRuns.id, scope.runId));
    await assert.rejects(enqueueStudioSteering(scope, "non-null", "Correction"), errorCode("RUN_NOT_FOUND"));
    assert.equal((await enqueueStudioSteering({ ...scope, conversationId: null }, "null-chat", "Correction")).status, "queued");
  });

  it("serializes concurrent acceptance without losing messages or duplicate request IDs", async () => {
    await Promise.all([enqueueStudioSteering(scope, "same", "First"), enqueueStudioSteering(scope, "same", "First"), enqueueStudioSteering(scope, "second", "Second")]);
    const items = readStudioSteering((await getRun()).context);
    assert.equal(items.length, 2);
    assert.deepEqual(new Set(items.map(item => item.id)), new Set(["same", "second"]));
  });

  it("keeps queue consumption immutable, ordered, complete and idempotent", async () => {
    await enqueueStudioSteering(scope, "first", "Keep IDs exact");
    await enqueueStudioSteering(scope, "second", "Preserve resolver");
    const run = await getRun(), messages = transcript();
    const savedContext = structuredClone(run.context), savedMessages = structuredClone(messages);
    const consumed = consumeStudioSteering(run.context, messages, 4);
    assert.deepEqual(run.context, savedContext);
    assert.deepEqual(messages, savedMessages);
    assert.deepEqual(consumed.messages.slice(0, messages.length), messages);
    assert.deepEqual(consumed.messages.slice(-2), [{ role: "user", content: "Keep IDs exact" }, { role: "user", content: "Preserve resolver" }]);
    assert.deepEqual(consumed.items.map(item => [item.id, item.status, item.beforeIteration]), [["first", "applied", 4], ["second", "applied", 4]]);
    assertToolPairing(consumed.messages);
    const twice = consumeStudioSteering(consumed.context, consumed.messages, 5);
    assert.deepEqual(twice.items, []);
    assert.deepEqual(twice.messages, consumed.messages);
  });

  it("preserves accepted input across the image-batch SQL context merge", async () => {
    const staleContext = (await getRun()).context;
    await enqueueStudioSteering(scope, "during-image-step", "Use the blue background");
    assert.equal(readStudioSteering(staleContext).length, 0);
    await db.update(agentRuns).set({ context: sql`COALESCE(${agentRuns.context}, '{}'::jsonb) || ${JSON.stringify({ imageBatchDeclined: true })}::jsonb` }).where(eq(agentRuns.id, scope.runId));
    const context = (await getRun()).context;
    assert.equal(context?.imageBatchDeclined, true);
    assert.equal(context?.activePanel, "entries");
    assert.equal(readStudioSteering(context)[0]?.id, "during-image-step");
  });

  it("rejects acceptance when the terminal transaction wins the same world/run locks", async () => {
    const entered = deferred(), release = deferred();
    const terminal = db.transaction(async tx => {
      await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, scope.worldId)).for("update");
      await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, scope.runId)).for("update");
      await tx.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, scope.runId));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const enqueue = enqueueStudioSteering(scope, "late", "Late correction");
    // Attach the rejection handler before releasing the transaction.
    const rejected = assert.rejects(enqueue, errorCode("RUN_FINISHED"));
    release.resolve();
    await Promise.all([terminal, rejected]);
    assert.deepEqual(readStudioSteering((await getRun()).context), []);
  });

  it("uses the same live worker when input wins against natural ask_user completion", async () => {
    const entered = deferred(), release = deferred();
    let calls = 0;
    const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
      calls++;
      if (calls === 1) {
        yield { type: "tool_call_end", content: "", toolCall: { id: "question", type: "function", function: { name: "ask_user", arguments: '{"question":"What should change next?"}' } } };
        entered.resolve();
        await release.promise;
      } else {
        assert.equal(calls, 2);
        const questionIndex = request.messages.findIndex(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "question"));
        assert.ok(questionIndex >= 0);
        assert.equal(request.messages[questionIndex + 1]?.role, "tool", "The earlier ask must be resolved before steering is appended");
        assert.deepEqual(request.messages[questionIndex + 2], { role: "user", content: "Keep entity-42 exactly" });
        assertToolPairing(request.messages);
        yield { type: "tool_call_end", content: "", toolCall: { id: "finished", type: "function", function: { name: "ask_user", arguments: '{"question":"Your correction is retained."}' } } };
      }
      yield { type: "done", content: "", stopReason: "tool_use" };
    } };
    const app = new Hono();
    app.get("/test", c => streamAgentLoop(c, { runId: scope.runId, conversationId: scope.conversationId!, worldId: scope.worldId, userId: scope.userId,
      world, messages: [{ role: "user", content: "Original task" }], model: "steering-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS }));
    const running = Promise.resolve(app.request("/test")).then(response => response.text());
    await entered.promise;
    const queued = await enqueueStudioSteering(scope, "last-step", "Keep entity-42 exactly");
    assert.equal(queued.status, "queued");
    release.resolve();
    const stream = await running;
    assert.doesNotMatch(stream, /event: error/);
    assert.match(stream, /event: steering/);
    assert.equal(calls, 2);
    const rows = await db.select().from(agentRuns).where(and(eq(agentRuns.userId, scope.userId), eq(agentRuns.worldId, scope.worldId)));
    assert.equal(rows.length, 1, "Steering must not create a replacement run");
    assert.equal(rows[0]?.id, scope.runId);
    assert.equal(rows[0]?.status, "awaiting_user");
    assert.equal(readStudioSteering(rows[0]?.context)[0]?.status, "applied");
  });

  it("summarizes in the same run with tools disabled, then continues the objective and newly queued corrections", async () => {
    const entered = deferred(), release = deferred(), summaryEntered = deferred(), summaryRelease = deferred();
    const objective = "Continue editing entity-42, preserve the custom resolver, and do not restart.";
    await db.update(agentRuns).set({ context: withStudioUserMessageContext(undefined, { role: "user", content: objective }) }).where(eq(agentRuns.id, scope.runId));
    let calls = 0;
    const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
      calls++;
      if (calls === 1) {
        yield { type: "tool_call_end", content: "", toolCall: { id: "ongoing", type: "function", function: { name: "ask_user", arguments: '{"question":"Any correction before continuing?"}' } } };
        entered.resolve(); await release.promise;
      } else if (calls === 2) {
        assert.deepEqual(request.tools, []);
        assert.equal(request.toolChoice, "none");
        assert.equal(request.disableReasoning, true);
        assert.equal(request.maxTokens, 6_000);
        assert.equal(request.messages.length, 2);
        assert.ok(request.messages.every(message => message.role !== "tool"));
        assert.match(String(request.messages[0]!.content), /Do not invent execution/);
        yield { type: "text", content: "Preserve entity-42 and its custom resolver. Earlier inspection is complete; the requested edit is still pending." };
        summaryEntered.resolve(); await summaryRelease.promise;
      } else {
        assert.equal(calls, 3);
        assert.ok((request.tools?.length ?? 0) > 0);
        assert.equal(request.toolChoice, "auto");
        assert.ok(request.messages.some(message => message.role === "user" && message.content === objective));
        assert.ok(request.messages.some(message => message.role === "user" && message.content === "Also preserve the blue background"));
        assert.ok(!request.messages.some(message => message.role === "user" && message.content === "/summarize"));
        assert.ok(estimateStudioTokens(request.messages.slice(1)) <= 10_050);
        assertToolPairing(request.messages);
        yield { type: "tool_call_end", content: "", toolCall: { id: "ready", type: "function", function: { name: "ask_user", arguments: '{"question":"Objective and correction retained; ready to continue."}' } } };
      }
      yield { type: "done", content: "", stopReason: calls === 2 ? "end_turn" : "tool_use" };
    } };
    const messages: ChatMessage[] = [{ role: "user", content: "Original inspection" }, { role: "assistant", content: "Older inspection details: " + "x".repeat(160_000) }, { role: "user", content: objective }];
    const app = new Hono();
    app.get("/test", c => streamAgentLoop(c, { runId: scope.runId, conversationId: scope.conversationId!, worldId: scope.worldId, userId: scope.userId,
      world, messages, model: "steering-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 5, tools: STUDIO_TOOLS }));
    const running = Promise.resolve(app.request("/test")).then(response => response.text());
    await entered.promise;
    await enqueueStudioSteering(scope, "compact-command", "/summarize");
    release.resolve();
    await summaryEntered.promise;
    await enqueueStudioSteering(scope, "during-summary", "Also preserve the blue background");
    summaryRelease.resolve();
    const stream = await running;
    assert.doesNotMatch(stream, /event: error/);
    assert.match(stream, /event: compaction/);
    assert.match(stream, /Context summarized/);
    assert.doesNotMatch(stream, /event: text\ndata: .*Earlier inspection is complete/);
    assert.equal(calls, 3);
    const run = await getRun(), metadata = run.context?.studioCompaction as Record<string, unknown>;
    assert.equal(run.id, scope.runId);
    assert.equal(run.status, "awaiting_user");
    assert.equal(metadata.success, true);
    assert.equal(metadata.status, "completed");
    assert.ok(Number(metadata.beforeTokens) > 40_000);
    assert.ok(Number(metadata.afterTokens) <= 10_000);
    assert.deepEqual(readStudioSteering(run.context).map(item => [item.id, item.status]), [["compact-command", "applied"], ["during-summary", "applied"]]);
    assert.equal(run.committedTurns.filter(turn => turn.lane === "notice").length, 1);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.worldId, scope.worldId))).length, 1);
  });

  it("completes an idle command-only compaction without generating an ordinary task turn", async () => {
    const original: ChatMessage = { role: "user", content: "Preserve the original naming instructions" };
    const older: ChatMessage = { role: "assistant", content: "Verified inspection: " + "x".repeat(160_000) };
    await db.insert(agentRuns).values({ id: crypto.randomUUID(), userId: scope.userId, worldId: scope.worldId, conversationId: scope.conversationId,
      status: "completed", model: "steering-test", createdAt: new Date(Date.now() - 60_000),
      context: withStudioUserMessageContext(undefined, original), committedTurns: [{ iteration: 0, textContent: String(older.content), lane: "answer", commitId: "older-answer", createdAt: new Date().toISOString() }] });
    await db.update(agentRuns).set({ context: withStudioUserMessageContext(undefined, { role: "user", content: "/summarize" }) }).where(eq(agentRuns.id, scope.runId));
    let calls = 0;
    const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
      calls++;
      assert.equal(calls, 1);
      assert.deepEqual(request.tools, []);
      assert.equal(request.toolChoice, "none");
      yield { type: "text", content: "Earlier inspection completed; preserve the exact naming instructions. No further edit was requested." };
      yield { type: "done", content: "", stopReason: "end_turn" };
    } };
    const app = new Hono();
    app.get("/test", c => streamAgentLoop(c, { runId: scope.runId, conversationId: scope.conversationId!, worldId: scope.worldId, userId: scope.userId,
      world, messages: [original, older, { role: "user", content: "/summarize" }], model: "steering-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS }));
    const stream = await (await app.request("/test")).text();
    assert.doesNotMatch(stream, /event: error/);
    assert.match(stream, /Context summarized/);
    assert.match(stream, /"status":"completed"/);
    assert.equal(calls, 1);
    const run = await getRun();
    assert.equal(run.status, "completed");
    assert.equal(run.committedTurns.length, 1);
    assert.equal(run.committedTurns[0]?.lane, "notice");
    const metadata = run.context?.studioCompaction as Record<string, unknown>;
    assert.equal(metadata.success, true);
    assert.ok(Number(metadata.afterTokens) <= 10_000);
    assert.ok((run.messages as unknown as ChatMessage[]).some(message => message.role === "user" && message.content === original.content));
    assert.ok(!(run.messages as unknown as ChatMessage[]).some(message => message.role === "user" && message.content === "/summarize"));
  });

  it("continues an idle summary worker when a real correction wins its terminal transaction", async () => {
    await db.update(agentRuns).set({ context: withStudioUserMessageContext(undefined, { role: "user", content: "/summarize" }) }).where(eq(agentRuns.id, scope.runId));
    const entered = deferred(), release = deferred();
    let calls = 0;
    const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
      calls++;
      if (calls === 1) {
        assert.deepEqual(request.tools, []);
        yield { type: "text", content: "The old inspection is complete. Preserve exact names." };
        entered.resolve(); await release.promise;
      } else {
        assert.equal(calls, 2);
        assert.ok((request.tools?.length ?? 0) > 0);
        assert.ok(request.messages.some(message => message.role === "user" && message.content === "Now update entity-42"));
        yield { type: "tool_call_end", content: "", toolCall: { id: "late-answer", type: "function", function: { name: "ask_user", arguments: '{"question":"New correction retained."}' } } };
      }
      yield { type: "done", content: "", stopReason: calls === 1 ? "end_turn" : "tool_use" };
    } };
    const app = new Hono();
    app.get("/test", c => streamAgentLoop(c, { runId: scope.runId, conversationId: scope.conversationId!, worldId: scope.worldId, userId: scope.userId,
      world, messages: [{ role: "user", content: "Keep names exact" }, { role: "assistant", content: "Older inspection" }, { role: "user", content: "/summarize" }], model: "steering-test", provider, isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS }));
    const running = Promise.resolve(app.request("/test")).then(response => response.text());
    await entered.promise;
    await enqueueStudioSteering(scope, "summary-terminal-followup", "Now update entity-42");
    release.resolve();
    const stream = await running;
    assert.doesNotMatch(stream, /event: error/);
    assert.equal(calls, 2);
    const run = await getRun();
    assert.equal(run.status, "awaiting_user");
    assert.equal((run.context?.studioCompaction as Record<string, unknown>).success, true);
    assert.equal(readStudioSteering(run.context)[0]?.status, "applied");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.worldId, scope.worldId))).length, 1);
  });

  it("keeps a full saved compacted prefix even when pinned instructions exceed 40 messages", async () => {
    const now = new Date().toISOString();
    const corrections = Array.from({ length: 45 }, (_, index) => ({ id: `pin-${index}`, content: `Exact constraint ${index}`, status: "applied" as const, createdAt: now, beforeIteration: 0 }));
    const coverage: ChatMessage[] = [{ role: "user", content: "Original task" }, ...corrections.map(item => ({ role: "user" as const, content: item.content }))];
    const compacted: ChatMessage[] = [{ role: "assistant", content: "[Earlier Studio work summary]\nVerified state" }, ...coverage];
    await db.update(agentRuns).set({ context: { ...withStudioUserMessageContext(undefined, coverage[0]!), [STUDIO_STEERING_KEY]: corrections, studioCompaction: { success: true, coverage, messages: compacted } },
      committedTurns: [{ iteration: 1, textContent: "Post-compaction answer", lane: "answer", commitId: "later", createdAt: now }], updatedAt: new Date(Date.now() + 1_000) }).where(eq(agentRuns.id, scope.runId));
    const history = await loadAgentHistoryForConversation({ userId: scope.userId, worldId: scope.worldId, conversationId: scope.conversationId! });
    assert.ok(history && history.length > 40);
    assert.equal(history[0]?.content, compacted[0]!.content);
    assert.deepEqual(history.filter(message => message.role === "user"), coverage);
    assert.equal(history.at(-1)?.content, "Post-compaction answer");
  });

  it("applies only valid compaction coverage and preserves later instructions", () => {
    const coverage: ChatMessage[] = [{ role: "user", content: "Original" }, { role: "assistant", content: "Old answer" }];
    const compacted: ChatMessage[] = [{ role: "assistant", content: "[Earlier Studio work summary]\nVerified facts" }, coverage[0]!];
    const runs = [{ context: { studioCompaction: { success: true, coverage, messages: compacted } }, committedTurns: [] }];
    const tail: ChatMessage = { role: "user", content: "New instruction after compaction" };
    assert.deepEqual(applyStudioCompactionHistory([...coverage, tail], runs), [...compacted, tail]);
    const edited: ChatMessage[] = [{ role: "user", content: "Corrected original" }, coverage[1]!, tail];
    assert.deepEqual(applyStudioCompactionHistory(edited, runs), edited);
    const removed = [coverage[1]!, tail];
    assert.deepEqual(applyStudioCompactionHistory(removed, runs), removed);
    const intervening: ChatMessage[] = [coverage[0]!, { role: "user", content: "Important intervening correction" }, coverage[1]!, tail];
    assert.deepEqual(applyStudioCompactionHistory(intervening, runs), intervening, "A subsequence match must not erase newer corrections");
  });

  it("reports unapplied input as failed on Stop/error and deduplicates retry acknowledgements", async () => {
    await enqueueStudioSteering(scope, "queued-before-stop", "Correction");
    await db.update(agentRuns).set({ status: "completed", error: "Stopped by user." }).where(eq(agentRuns.id, scope.runId));
    const run = await getRun();
    assert.equal(readStudioSteering(run.context, run.status)[0]?.status, "failed");
    assert.equal((await enqueueStudioSteering(scope, "queued-before-stop", "Correction")).status, "failed");
    await assert.rejects(enqueueStudioSteering(scope, "new-after-stop", "New correction"), errorCode("RUN_FINISHED"));
    assert.equal(readStudioSteering(run.context, "error")[0]?.status, "failed");
  });

  it("atomically closes a paid generated result with consumed input and the next preflight", async () => {
    const revision = await captureStudioCreditWorldRevision(scope), claimId = crypto.randomUUID();
    const original = transcript();
    const checkpoint: StudioCreditCheckpoint = { version: 1, phase: "generated", messages: original, iteration: 2, worldRevision: revision.revision, requiredCredits: 0,
      claim: { id: claimId, claimedAt: new Date().toISOString() }, generated: { textContent: "Already paid result", toolCalls: [], cost: 1, usageLogId: crypto.randomUUID(), settled: true } };
    await db.update(agentRuns).set({ creditCheckpoint: checkpoint as unknown as Record<string, unknown>, messages: original as unknown as Array<Record<string, unknown>> }).where(eq(agentRuns.id, scope.runId));
    await enqueueStudioSteering(scope, "paid-followup", "Preserve paid changes");
    const saved = await withStudioCreditClaimTransaction(scope, claimId, async (_tx, current, _schema, lockedRun) => {
      assert.equal(current.phase, "generated");
      assert.equal(lockedRun.id, scope.runId, "The callback receives the locked run, not a stale snapshot");
      const consumed = consumeStudioSteering(lockedRun.context, original, 3);
      return { value: consumed.items.length, checkpoint: { version: 1, phase: "preflight", messages: consumed.messages, iteration: 3, worldRevision: current.worldRevision, requiredCredits: 0 },
        runUpdates: { messages: consumed.messages as unknown as Array<Record<string, unknown>>, context: consumed.context, iteration: 3 } };
    }, { rebase: true });
    assert.equal(saved.value, 1);
    const run = await getRun(), persisted = readStudioCreditCheckpoint(run.creditCheckpoint);
    assert.equal(persisted?.phase, "preflight");
    assert.equal(persisted?.claim?.id, claimId);
    assert.deepEqual(persisted?.messages, run.messages);
    assert.deepEqual(persisted?.messages.at(-1), { role: "user", content: "Preserve paid changes" });
    assert.equal(readStudioSteering(run.context)[0]?.status, "applied");
    const again = consumeStudioSteering(run.context, persisted!.messages, 4);
    assert.equal(again.items.length, 0);
    assert.deepEqual(again.messages, persisted?.messages);
  });

  it("rolls back consumed context and world changes if the checkpoint commit fails", async () => {
    const revision = await captureStudioCreditWorldRevision(scope), claimId = crypto.randomUUID();
    const checkpoint: StudioCreditCheckpoint = { version: 1, phase: "generated", messages: transcript(), iteration: 2, worldRevision: revision.revision, requiredCredits: 0,
      claim: { id: claimId, claimedAt: new Date().toISOString() }, generated: { textContent: "Paid", toolCalls: [], cost: 1, usageLogId: crypto.randomUUID(), settled: true } };
    await db.update(agentRuns).set({ creditCheckpoint: checkpoint as unknown as Record<string, unknown> }).where(eq(agentRuns.id, scope.runId));
    await enqueueStudioSteering(scope, "rollback", "Do not lose this");
    const before = await getRun();
    await assert.rejects(withStudioCreditClaimTransaction(scope, claimId, async (tx, current, _schema, lockedRun) => {
      const consumed = consumeStudioSteering(lockedRun.context, current.messages, 3);
      await tx.update(agentRuns).set({ context: consumed.context }).where(eq(agentRuns.id, scope.runId));
      await tx.update(worlds).set({ name: "Should roll back" }).where(eq(worlds.id, scope.worldId));
      throw new Error("Synthetic checkpoint failure");
    }, { rebase: true }), /Synthetic checkpoint failure/);
    const after = await getRun();
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.creditCheckpoint, before.creditCheckpoint);
    assert.deepEqual(after.messages, before.messages);
    assert.equal((await db.select({ name: worlds.name }).from(worlds).where(eq(worlds.id, scope.worldId)))[0]?.name, world.name);
  });

  it("rehydrates applied input between committed answers without replaying queued input or commands", async () => {
    const now = new Date().toISOString();
    const context = { ...withStudioUserMessageContext(undefined, { role: "user", content: "Original task" }), [STUDIO_STEERING_KEY]: [
      { id: "followup-a", content: "Correction A", status: "applied", createdAt: now, beforeIteration: 1 },
      { id: "followup-b", content: "Correction B", status: "applied", createdAt: now, beforeIteration: 1 },
      { id: "summary-command", content: "/summarize", status: "applied", createdAt: now, beforeIteration: 2 },
      { id: "pending", content: "Unapplied correction", status: "queued", createdAt: now },
    ] };
    const committedTurns = [{ iteration: 0, textContent: "First answer", createdAt: now, commitId: "first", lane: "answer" as const }, { iteration: 1, textContent: "Second answer", createdAt: now, commitId: "second", lane: "answer" as const }];
    const history = serverOwnedStudioRunsToAgentHistory([{ context, committedTurns }]);
    assert.deepEqual(history.map(message => message.content), ["Original task", "First answer", "Correction A", "Correction B", "Second answer"]);
    await db.update(agentRuns).set({ context, committedTurns, updatedAt: new Date(Date.now() + 1_000) }).where(eq(agentRuns.id, scope.runId));
    const display = await loadStudioConversationForDisplay({ userId: scope.userId, worldId: scope.worldId, conversationId: scope.conversationId! });
    assert.ok(display);
    assert.equal(display.messages.filter(message => message.id === "followup-a").length, 1);
    assert.equal(display.messages.find(message => message.id === "followup-a")?.agentRunId, scope.runId);
    const first = display.messages.findIndex(message => message.commitId === "first"), correction = display.messages.findIndex(message => message.id === "followup-a"), second = display.messages.findIndex(message => message.commitId === "second");
    assert.ok(first < correction && correction < second);
    const reload = await loadStudioConversationForDisplay({ userId: scope.userId, worldId: scope.worldId, conversationId: scope.conversationId! });
    assert.deepEqual(reload?.messages, display.messages);
  });
});
