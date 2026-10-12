import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createCharacterGuardTransport, fitCharacterGuardMessages } from "./story-character-transport.js";
import { estimateTokens } from "@yumina/engine";

test("guard fitting removes old history before dropping authoritative identities or the draft", () => {
  const messages = [{ role: "system" as const, content: "Required identity facts." }, ...Array.from({ length: 10 }, () => ({ role: "assistant" as const, content: "Old history. ".repeat(200) })), { role: "user" as const, content: "Required draft." }];
  const fitted = fitCharacterGuardMessages(messages, 1, "custom/test", 100);
  assert.equal(fitted[0]!.content, "Required identity facts.");
  assert.equal(fitted.at(-1)!.content, "Required draft.");
  assert.ok(fitted.reduce((n,m) => n + estimateTokens(m.content as string, "custom/test") + 4, 3) <= 100);
});

test("guard transport records actual routed model/tier and usage even on provider failure", async () => {
  const logs: any[] = [];
  const provider = { listModels: async () => [], async *generateStream() { yield { type: "text" as const, content: "partial" }; yield { type: "error" as const, content: "upstream failure" }; } };
  const resolved = { provider, providerName: "custom" as const, isByok: true, apiKeyTier: "byok" as const };
  const request = createCharacterGuardTransport({ userId: "unit", selected: { resolved, model: "custom/selected" }, maxContext: 8000, signal: new AbortController().signal, startedAt: Date.now(), route: async args => ({ ...args.selected, model: "custom/routed", messages: args.messages, routingLabel: "nsfw", rerouted: true, maxContext: 5000 }), recordUsage: async record => { logs.push(record); } });
  await assert.rejects(request({ stage: "review", messages: [{ role: "user", content: "Check a draft." }], history: [], maxTokens: 768 }), /character_identity_provider_failed/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].model, "custom/routed");
  assert.equal(logs[0].apiKeyTier, "byok");
  assert.ok(logs[0].usage.completionTokens > 0);
  assert.equal(logs[0].completed, false);
});

test("guard transport uses destination fitting and preserves provider-reported usage", async () => {
  const logs: any[] = [];
  let called = false;
  const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110, providerRequestId: "safe-unit-id" };
  const provider = { listModels: async () => [], async *generateStream(params: any) { called = true; assert.equal(params.model, "custom/routed"); assert.equal(params.disableReasoning, true); yield { type: "text" as const, content: '{"valid":true,"issues":[]}' }; yield { type: "done" as const, content: "", usage }; } };
  const resolved = { provider, providerName: "custom" as const, isByok: true, apiKeyTier: "byok" as const };
  const request = createCharacterGuardTransport({ userId: "unit", selected: { resolved, model: "custom/selected" }, maxContext: 8000, signal: new AbortController().signal, startedAt: Date.now(), route: async args => { const messages = await args.fitContext!(args.messages, "custom/routed", 1000); return { ...args.selected, model: "custom/routed", messages, routingLabel: "nsfw", rerouted: true, maxContext: 1000 }; }, recordUsage: async record => { logs.push(record); } });
  const result = await request({ stage: "review", messages: [{ role: "system", content: "Required facts." }, { role: "user", content: "Check the draft." }], history: [{ role: "assistant", content: "Older history. ".repeat(2000) }], maxTokens: 768 });
  assert.equal(called, true);
  assert.equal(result.raw, '{"valid":true,"issues":[]}');
  assert.deepEqual(logs[0].usage, usage);
  assert.equal(logs[0].completed, true);
});
