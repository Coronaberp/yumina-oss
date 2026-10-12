import assert from "node:assert/strict";
import test from "node:test";
import { createByokProvider } from "./provider-factory.js";
import type { ApiKeyMetadata } from "@yumina/shared";

test("saved OpenRouter providers constrain both streaming and non-streaming requests per model", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  };
  try {
    const provider = createByokProvider("openrouter", "test-key", undefined, {
      openRouterProviders: {
        "deepseek/deepseek-v3.2": ["cohere", "deepinfra/turbo"],
        "google/gemini-2.5-pro": ["google-vertex/us-east5"],
      },
    } as ApiKeyMetadata);
    for (const stream of [true, false]) {
      for await (const _chunk of provider.generateStream({ model: "deepseek/deepseek-v3.2", messages: [{ role: "user", content: "Hello" }], stream, singleAttempt: true })) { /* consume */ }
      assert.deepEqual(bodies.at(-1)?.provider, { only: ["cohere", "deepinfra/turbo"], allow_fallbacks: false });
    }
    for await (const _chunk of provider.generateStream({ model: "google/gemini-2.5-pro", messages: [], singleAttempt: true })) { /* consume */ }
    assert.deepEqual(bodies.at(-1)?.provider, { only: ["google-vertex/us-east5"], allow_fallbacks: false });
    for await (const _chunk of provider.generateStream({ model: "google/gemini-2.5-flash", messages: [], singleAttempt: true })) { /* consume */ }
    assert.equal(bodies.at(-1)?.provider, undefined, "unconfigured models keep OpenRouter account routing");
  } finally { globalThis.fetch = originalFetch; }
});

test("OpenRouter retries keep the selected providers when an upstream endpoint fails", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: { message: "Endpoint unavailable" }, openrouter_metadata: { attempts: [{ provider: "cohere", status: 503 }] } }, { status: 503 });
  };
  try {
    const provider = createByokProvider("openrouter", "test-key", undefined, { openRouterProviders: { "deepseek/deepseek-v3.2": ["cohere"] } } as ApiKeyMetadata);
    const chunks = [];
    for await (const chunk of provider.generateStream({ model: "deepseek/deepseek-v3.2", messages: [], stream: false })) chunks.push(chunk);
    assert.ok(bodies.length > 0);
    for (const body of bodies) assert.deepEqual(body.provider, { only: ["cohere"], allow_fallbacks: false });
    assert.ok(chunks.some(chunk => chunk.type === "error" && chunk.content.includes("Endpoint unavailable")));
  } finally { globalThis.fetch = originalFetch; }
});
