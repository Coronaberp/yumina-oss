import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "./llm/types.js";
import { estimateStudioTokens, isStudioSummaryRequest, buildStudioCompactedMessages, buildStudioSummaryPrompt } from "./studio-context-compaction.js";

const command: ChatMessage = { role: "user", content: "/summarize" };
function toolGroup(id: string, content: string): ChatMessage[] {
  return [
    { role: "assistant", content: `Applied ${id}`, reasoning_content: `Exact reasoning for ${id}`, tool_calls: [
      { id: `${id}-one`, type: "function", function: { name: "edit_entities", arguments: '{"id":"entity-42"}' } },
      { id: `${id}-two`, type: "function", function: { name: "read_entities", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: `${id}-one`, content },
    { role: "tool", tool_call_id: `${id}-two`, content: "Verified entity-42" },
  ];
}

function assertCompleteTools(messages: ChatMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    let owner = index - 1;
    while (owner >= 0 && messages[owner]!.role === "tool") owner--;
    const assistant = messages[owner];
    assert.ok(assistant?.role === "assistant" && assistant.tool_calls?.some(call => call.id === message.tool_call_id));
  }
}

describe("Studio explicit context compaction", () => {
  it("matches CJK, multimodal and assistant argument token estimates", () => {
    assert.equal(estimateStudioTokens([{ role: "user", content: "abcd漢字" }]), 3);
    assert.equal(estimateStudioTokens([{ role: "user", content: [{ type: "text", text: "abcd" }, { type: "image_url", image_url: { url: "https://example.test/art.png" } }] }]), 201);
    assert.equal(estimateStudioTokens([{ role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "edit", arguments: "x".repeat(4_000) } }] }]), 1_000);
  });

  it("recognizes only a standalone command in the trailing user block", () => {
    assert.equal(isStudioSummaryRequest([{ role: "user", content: "Keep IDs exact" }, command]), true);
    assert.equal(isStudioSummaryRequest([command, { role: "tool", tool_call_id: "x", content: "result" }]), true);
    assert.equal(isStudioSummaryRequest([command, { role: "assistant", content: "Done" }]), false);
    assert.equal(isStudioSummaryRequest([{ role: "user", content: "Please /summarize this file" }]), false);
    assert.equal(isStudioSummaryRequest([{ role: "user", content: " /summarize\n" }]), true);
    assert.equal(isStudioSummaryRequest([{ role: "user", content: [{ type: "text", text: "/summarize" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } }] }]), false);
  });

  it("reduces a 40k history below 10k while retaining every user instruction verbatim", () => {
    const original: ChatMessage[] = [
      { role: "user", content: "Do not restart. Change only entity-42. Keep all names exact." },
      { role: "assistant", content: "Earlier lengthy work: " + "a".repeat(150_000) },
      { role: "user", content: "Correction: preserve the custom resolver and never replace it." },
      ...toolGroup("recent", "Saved the requested change"),
      { role: "user", content: [{ type: "text", text: "Use this exact reference" }, { type: "image_url", image_url: { url: "https://example.test/ref.png" } }] },
      command,
    ];
    const snapshot = structuredClone(original);
    const result = buildStudioCompactedMessages(original, "Only entity-42 changed; validation is pending. " + "summary facts ".repeat(5_000));
    assert.ok(result.beforeTokens > 37_000);
    assert.equal(result.beforeTokens, estimateStudioTokens(original));
    assert.equal(result.success, true);
    assert.ok(result.afterTokens <= 10_000);
    assert.equal(result.afterTokens, estimateStudioTokens(result.messages));
    assert.ok(result.afterTokens < result.beforeTokens / 2);
    assert.deepEqual(result.messages.filter(message => message.role === "user"), original.filter(message => message.role === "user" && message !== command));
    assert.deepEqual(original, snapshot, "Compaction must not mutate the audit transcript");
    assertCompleteTools(result.messages);
  });

  it("retains whole recent multi-tool turns including exact reasoning, without duplicating users", () => {
    const recent = toolGroup("latest", "result");
    const user: ChatMessage = { role: "user", content: "Follow-up: entity-42 should stay enabled" };
    const result = buildStudioCompactedMessages([{ role: "user", content: "Original task" }, ...toolGroup("old", "x".repeat(80_000)), user, ...recent, command], "The old large read concerned entity-42.");
    assert.equal(result.success, true);
    assert.deepEqual(result.messages.slice(-recent.length), recent);
    assert.equal(result.messages.filter(message => message === user).length, 1);
    assert.ok(!result.messages.some(message => message.role === "tool" && message.tool_call_id === "old-one"));
    assertCompleteTools(result.messages);
  });

  it("does not split an oversized latest tool group to force it into the recent budget", () => {
    const result = buildStudioCompactedMessages([{ role: "user", content: "Keep the task" }, ...toolGroup("large", "x".repeat(20_000)), command], "The large tool exchange returned file contents; no mutation was executed.");
    assert.equal(result.success, true);
    assert.equal(result.messages.filter(message => message.role === "tool").length, 0);
    assertCompleteTools(result.messages);
  });

  it("returns the original transcript without control commands when mandatory instructions exceed target", () => {
    const source: ChatMessage[] = [{ role: "user", content: "漢".repeat(10_000) }, ...toolGroup("keep", "Exact result"), command];
    const result = buildStudioCompactedMessages(source, "Cannot replace actual instructions");
    assert.equal(result.success, false);
    assert.equal(result.reason, "mandatory_context_exceeds_target");
    assert.deepEqual(result.messages, source.slice(0, -1));
    assert.ok(result.afterTokens >= 10_000);
  });

  it("caps CJK and emoji summaries by tokens without splitting Unicode surrogate pairs", () => {
    for (const summary of ["漢字".repeat(1_000), "🙂".repeat(1_000)]) {
      const result = buildStudioCompactedMessages([{ role: "user", content: "Exact task" }, command], summary, 100);
      assert.equal(result.success, true);
      assert.ok(result.afterTokens <= 100);
      assert.match(String(result.messages[0]!.content), /^\[Earlier Studio work summary\]/);
      assert.doesNotMatch(String(result.messages[0]!.content), /[\uD800-\uDFFF]/u);
    }
  });

  it("fails without damaging history for empty output or insufficient summary budget", () => {
    const source: ChatMessage[] = [{ role: "user", content: "x".repeat(360) }, ...toolGroup("keep", "result"), command];
    assert.equal(buildStudioCompactedMessages(source, "  ").reason, "empty_summary");
    const tight = buildStudioCompactedMessages(source, "Important facts", 91);
    assert.equal(tight.success, false);
    assert.equal(tight.reason, "summary_budget_too_small");
    assert.deepEqual(tight.messages, source.slice(0, -1));
    assert.throws(() => buildStudioCompactedMessages(source, "Facts", 0), RangeError);
  });

  it("preserves existing system messages and does not treat attached commands as disposable", () => {
    const system: ChatMessage = { role: "system", content: "Preserve this instruction exactly." };
    const attached: ChatMessage = { role: "user", content: [{ type: "text", text: "/summarize" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } }] };
    const result = buildStudioCompactedMessages([system, attached, command], "Earlier work");
    assert.equal(result.success, true);
    assert.ok(result.messages.includes(system));
    assert.ok(result.messages.includes(attached));
  });

  it("builds a text-only semantic handoff prompt, preserving transcript data and excluding commands", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Keep entry-42 and file index.tsx" }, ...toolGroup("applied", "status: applied"), command];
    const prompt = buildStudioSummaryPrompt(messages);
    assert.equal(prompt.length, 2);
    assert.equal(prompt[0]!.role, "system");
    assert.match(String(prompt[0]!.content), /6,000 tokens|constraints|corrections|actually applied|Do not invent execution/);
    assert.deepEqual(JSON.parse(String(prompt[1]!.content)), messages.slice(0, -1));
    assert.ok(prompt.every(message => message.role !== "tool"));
  });
});
