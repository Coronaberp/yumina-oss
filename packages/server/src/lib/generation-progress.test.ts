import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationProgressReporter } from "./generation-progress.js";

test("progress counts thinking and buffered story without exposing either", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const events: unknown[] = [];
  const report = createGenerationProgressReporter(async message => { events.push(message); });
  await report({ type: "reasoning", content: "plan" });
  now = 1100;
  await report({ type: "text", content: "A reply." });
  now = 1110;
  await report({ type: "text", content: "More" });
  assert.deepEqual(events, [
    { event: "progress", data: '{"tokens":1}' },
    { event: "progress", data: '{"tokens":3}' },
  ], "updates are limited to ten per second");
  await report({ type: "done", content: "" });
  assert.deepEqual(events.at(-1), { event: "progress", data: '{"tokens":4}' }, "completion flushes the final estimate");
  await report({ type: "done", content: "" });
  await report({ type: "error", content: "provider error" });
  assert.equal(events.length, 3, "terminal frames never increase the count");
});

test("empty generation emits no fabricated progress and a fresh attempt starts from zero", async () => {
  const first: unknown[] = [], second: unknown[] = [];
  const report = createGenerationProgressReporter(async message => { first.push(message); });
  await report({ type: "text", content: "" });
  await report({ type: "done", content: "" });
  assert.deepEqual(first, []);
  await report({ type: "text", content: "A long earlier reply" });
  const retry = createGenerationProgressReporter(async message => { second.push(message); });
  await retry({ type: "text", content: "Hi" });
  assert.deepEqual(second, [{ event: "progress", data: '{"tokens":1}' }]);
});
