import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "./openai.js";
import { CustomProvider } from "./custom.js";
import { OpenRouterProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./types.js";
import type { WireRequest } from "../request-inspection.js";

for (const stream of [true, false]) {
  for (const [name, factory, model] of [
    ["openai", () => new OpenAIProvider("synthetic-key"), "openai/gpt-5"],
    ["custom", () => new CustomProvider("synthetic-key", "https://example.com/v1", { includeBody: { temperature: .25 } }), "custom/model"],
    ["openrouter", () => new OpenRouterProvider("synthetic-key"), "google/gemini-2.5-flash"],
    ["anthropic", () => new AnthropicProvider("synthetic-key"), "anthropic/claude-sonnet-4"],
    ["google", () => new GoogleProvider("synthetic-key"), "google/gemini-2.5-flash"],
    ["ollama", () => new OllamaProvider(), "ollama/test"],
  ] as Array<[string, () => LLMProvider, string]>) {
    test(`${name} captures the final ${stream ? "streaming" : "nonstreaming"} body without changing dispatch`, async t => {
      const wire: unknown[] = [], captured: WireRequest[] = [];
      t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        wire.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 503 });
      });
      for await (const _chunk of factory().generateStream({ model, messages: [{ role: "system", content: "system" }, { role: "user", content: "final input" }], temperature: .9, maxTokens: 700, stream, singleAttempt: true,
        onRequest: value => captured.push({ ...value, body: JSON.parse(JSON.stringify(value.body)) }),
      })) { /* no upstream call */ }
      assert.ok(wire.length > 0);
      assert.deepEqual(captured.map(value => value.body), wire);
      assert.ok(captured.every(value => value.provider === name));
      assert.ok(captured.every(value => !JSON.stringify(value.body).includes("synthetic-key")));
    });
  }
}

test("OpenAI unsupported-parameter retry captures each changed wire body", async t => {
  const captured: WireRequest[] = [], wire: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    wire.push(JSON.parse(String(init?.body)));
    return wire.length === 1 ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'.", param: "temperature", code: "unsupported_parameter" } }), { status: 400 }) : Response.json({ choices: [{ message: { content: "reply" } }] });
  });
  for await (const _chunk of new OpenAIProvider("key").generateStream({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }], temperature: .7, stream: false, onRequest: value => captured.push({ ...value, body: JSON.parse(JSON.stringify(value.body)) }) })) { }
  assert.equal(wire.length, 2);
  assert.deepEqual(captured.map(value => value.body), wire);
  assert.equal("temperature" in captured[1]!.body, false);
});
