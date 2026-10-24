import assert from "node:assert/strict";
import test from "node:test";
import { CustomProvider } from "./custom.js";
import type { GenerateParams, ProviderAttempt, StreamChunk } from "./types.js";

const messages = [{ role: "user" as const, content: "Extract memory." }];
const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, completion_tokens_details: { reasoning_tokens: 30 } };
function response(stream: boolean, content = "[]") {
  const headers = { "x-ci-request-id": "ci-request-1" };
  return stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers })
    : Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { ...usage, cost: 0.0004 } }, { headers });
}
async function collect(provider: CustomProvider, params: Partial<GenerateParams> = {}) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.generateStream({ model: "custom/deepseek-v4.1-flash", messages, ...params })) chunks.push(chunk);
  return chunks;
}

for (const stream of [true, false]) {
  test(`CheaperInference honors a background DeepSeek opt-out after profile shaping (${stream})`, async t => {
    const bodies: Record<string, any>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return response(stream); });
    const provider = new CustomProvider("fixture", "https://api.cheaperinference.com/v1", {
      reasoningEffort: "high", includeBody: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
    await collect(provider, { disableReasoning: true, singleAttempt: true, stream });
    assert.deepEqual(bodies[0]!.thinking, { type: "disabled" });
    assert.equal(bodies[0]!.reasoning_effort, undefined);
  });

  test(`completed empty replies stop after one paid attempt and retain usage (${stream})`, async t => {
    let calls = 0;
    const receipts: ProviderAttempt[] = [];
    t.mock.method(globalThis, "fetch", async () => { calls++; return response(stream, ""); });
    const chunks = await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
      stream, onProviderAttempt: async receipt => { receipts.push(receipt); },
    });
    assert.equal(calls, 1);
    assert.equal(chunks.at(-1)?.type, "done");
    assert.equal(chunks.at(-1)?.usage?.completionTokens, 40);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.usage?.reasoningTokens, 30);
    assert.equal(receipts[0]!.providerRequestId, "ci-request-1");
  });

  test(`custom responses retain reconciliation metadata (${stream})`, async t => {
    t.mock.method(globalThis, "fetch", async () => response(stream));
    const chunks = await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), { stream, singleAttempt: true });
    const done = chunks.at(-1)!;
    assert.equal(done.providerRequestId, "ci-request-1");
    assert.equal(done.usage?.providerRequestId, "ci-request-1");
    assert.equal(done.usage?.reasoningTokens, 30);
    if (!stream) assert.equal(done.usage?.providerCostUsd, 0.0004);
  });
}

test("each transient HTTP attempt is observed before another request is sent", async t => {
  const receipts: ProviderAttempt[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(receipts.length, calls);
    calls++;
    return calls < 3 ? new Response("temporary", { status: 503 }) : response(false);
  });
  await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
    stream: false, onProviderAttempt: async receipt => { receipts.push(receipt); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(receipts.map(r => r.status), ["error", "error", "complete"]);
  assert.deepEqual(receipts.map(r => r.httpStatus), [503, 503, 200]);
  assert.equal(new Set(receipts.map(r => r.id)).size, 3);
  assert.equal(new Set(receipts.map(r => r.invocationId)).size, 1);
  assert.equal(receipts[0]!.usage, undefined);
});

test("unsupported-parameter retry records both HTTP requests", async t => {
  const receipts: ProviderAttempt[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? Response.json({ error: { message: "Unsupported parameter: 'top_k'." } }, { status: 400 }) : response(false);
  });
  await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
    topK: 40, stream: false, onProviderAttempt: async r => { receipts.push(r); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(receipts.map(r => r.httpStatus), [400, 200]);
});

test("cancelling an in-flight request still records the attempted call", async t => {
  const controller = new AbortController();
  const receipts: ProviderAttempt[] = [];
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); throw new Error("cancelled"); });
  await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
    stream: false, signal: controller.signal, onProviderAttempt: async r => { receipts.push(r); },
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, "cancelled");
  assert.equal(receipts[0]!.usage, undefined);
});

test("ordinary story reasoning and unsupported endpoint contracts stay unchanged", async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return response(false); });
  await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1", { reasoningEffort: "high" }), { stream: false });
  await collect(new CustomProvider("fixture", "https://compatible.example/v1"), { stream: false, disableReasoning: true });
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[1].thinking, undefined);
});

test("a buffered response retains reported usage even when its consumer stops at the first text", async t => {
  const receipts: ProviderAttempt[] = [];
  t.mock.method(globalThis, "fetch", async () => response(false));
  const provider = new CustomProvider("fixture", "https://api.cheaperinference.com/v1");
  for await (const chunk of provider.generateStream({ model: "custom/test", messages, stream: false,
    onProviderAttempt: async r => { receipts.push(r); } })) {
    if (chunk.type === "text") break;
  }
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.usage?.completionTokens, 40);
  assert.equal(receipts[0]!.usage?.providerCostUsd, 0.0004);
});

test("missing token counters and blank billing costs never become reported zero usage", async t => {
  const receipts: ProviderAttempt[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ message: { content: "[]" } }], usage: { completion_tokens: 4 }, billing: { billed_cost_usd: "" },
  }));
  await collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
    stream: false, onProviderAttempt: async r => { receipts.push(r); },
  });
  assert.equal(receipts[0]!.usage?.completionTokens, 4);
  assert.equal(receipts[0]!.usage?.promptTokens, undefined);
  assert.equal(receipts[0]!.usage?.totalTokens, undefined);
  assert.equal(receipts[0]!.usage?.providerCostUsd, undefined);
});

test("a broken stream is an error receipt and never triggers another paid call", async t => {
  const receipts: ProviderAttempt[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection dropped")); } }));
  });
  await assert.rejects(() => collect(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), {
    onProviderAttempt: async r => { receipts.push(r); },
  }), /connection dropped/);
  assert.equal(calls, 1);
  assert.equal(receipts[0]!.status, "error");
});
