import assert from "node:assert/strict";
import test from "node:test";
import { cleanProviderText } from "./clean-provider-text.js";
import type { GenerateParams, LLMProvider, StreamChunk } from "./types.js";

test("every provider stream removes zero-width spaces from prompts, prose, reasoning and tool text", async () => {
  let captured: GenerateParams | undefined;
  const chunks: StreamChunk[] = [
    { type: "text", content: "[\u200BSPEAKER:Sera:smug] Hel\u200Blo\u200C\u200D", providerRequestId: "request" },
    { type: "reasoning", content: "Think\u200Bing" },
    { type: "tool_call_end", content: '{"text":"Hel\u200Blo"}', toolCall: { id: "tool", type: "function", function: { name: "write", arguments: '{"text":"Hel\u200Blo"}' } } },
    { type: "done", content: "", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, stopReason: "stop", model: "chosen" },
  ];
  class FixtureProvider implements LLMProvider {
    async *generateStream(params: GenerateParams) { assert.equal(this, original); captured = params; yield* chunks; }
    async listModels() { assert.equal(this, original); return []; }
    async getContextWindow() { assert.equal(this, original); return 4096; }
    async verify() { assert.equal(this, original); return true; }
  }
  const original = new FixtureProvider(), provider = cleanProviderText(original);
  const params: GenerateParams = { model: "chosen", messages: [
    { role: "user", content: "Hel\u200Blo\u200C\u200D" },
    { role: "user", content: [{ type: "text", text: "Hel\u200Blo", cache_control: { type: "ephemeral" } }, { type: "image_url", image_url: { url: "https://example.invalid/image" } }] },
    { role: "assistant", content: "Old\u200B reply", reasoning_content: "Old\u200B thinking", tool_calls: [{ id: "prior-tool", type: "function", function: { name: "read", arguments: '{"text":"Hel\u200Blo"}' } }] },
    { role: "tool", tool_call_id: "prior-tool", content: "Old\u200B result" },
  ] };
  const output: StreamChunk[] = [];
  for await (const chunk of provider.generateStream(params)) output.push(chunk);
  assert.equal(output.length, chunks.length);
  assert.equal(output[0]!.content, "[SPEAKER:Sera:smug] Hello\u200C\u200D", "legitimate joining characters are preserved");
  assert.equal(output[1]!.content, "Thinking");
  assert.equal(output[2]!.toolCall?.function.arguments, '{"text":"Hello"}');
  assert.deepEqual(output[3], chunks[3], "usage, model and stop reason are preserved");
  assert.equal(output[0]!.providerRequestId, "request");
  assert.doesNotMatch(JSON.stringify(captured?.messages), /\u200B/);
  assert.equal(captured?.messages[0]?.content, "Hello\u200C\u200D");
  assert.match(JSON.stringify(params.messages), /\u200B/, "caller-owned history is not mutated");
  assert.match(chunks[0]!.content, /\u200B/, "provider-owned chunks are not mutated");
  assert.ok(provider instanceof FixtureProvider);
  assert.deepEqual(await provider.listModels(), []);
  assert.equal(await provider.getContextWindow?.(), 4096);
  assert.equal(await provider.verify?.(), true);
});
