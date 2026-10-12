import assert from "node:assert/strict";
import test from "node:test";
import { replyMetrics } from "../../../../../interfaces/vn/reply-metrics";

test("reply speed uses estimated generated output including thinking, not the total context", () => {
  const result = replyMetrics({ tokenCount: 27000, generationTimeMs: 2000, swipes: [{ content: "story", rawContent: "x".repeat(400), reasoningContent: "x".repeat(200), tokenCount: 27000 }] });
  assert.deepEqual(result, { totalTokens: 27000, inputTokens: 26850, outputTokens: 150, estimatedTps: 75 });
});

test("metrics follow the selected reply version without borrowing another version's timing", () => {
  const swipes = [
    { content: "x".repeat(400), tokenCount: 1000 },
    { content: "x".repeat(800), tokenCount: 2000 },
  ];
  assert.deepEqual(replyMetrics({ swipes, activeSwipeIndex: 0, tokenCount: 2000, generationTimeMs: 1000 }), { totalTokens: 1000, inputTokens: 900, outputTokens: 100, estimatedTps: null });
  assert.deepEqual(replyMetrics({ swipes, activeSwipeIndex: 1, tokenCount: 2000, generationTimeMs: 1000 }), { totalTokens: 2000, inputTokens: 1800, outputTokens: 200, estimatedTps: null });
});

test("greetings and replies without saved generation metadata do not invent usage", () => {
  assert.equal(replyMetrics(undefined), null);
  assert.equal(replyMetrics({ content: "An opening scene." }), null);
  assert.equal(replyMetrics({ content: "failed", status: "failed", tokenCount: 1000 }), null);
});

test("missing or invalid duration shows an unknown rate instead of zero or infinity", () => {
  for (const generationTimeMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(replyMetrics({ content: "x".repeat(20), tokenCount: 100, generationTimeMs }), { totalTokens: 100, inputTokens: 95, outputTokens: 5, estimatedTps: null });
  }
});
