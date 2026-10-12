import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingChoicesFromMessages } from "./pending-choices";

test("choices follow the selected final assistant swipe and clear after player input", () => {
  const assistant = { role: "assistant", activeSwipeIndex: 1, swipes: [{ choices: ["old"] }, { choices: ["A", "B"] }] };
  assert.deepEqual(pendingChoicesFromMessages([assistant]), ["A", "B"]);
  assert.deepEqual(pendingChoicesFromMessages([assistant, { role: "user" }]), []);
  assert.deepEqual(pendingChoicesFromMessages([{ role: "assistant", swipes: [{}] }]), []);
});

test("empty metadata cannot mask raw choices, while explicit empty raw blocks stop fallback", () => {
  const current = { role: "assistant", content: '[CHOICES: ["stale A", "stale B"]]', activeSwipeIndex: 1,
    swipes: [{ choices: ["wrong swipe"] }, { choices: [], rawContent: 'Story [CHOICES: ["Ask her", "Wait"]]' }] };
  assert.deepEqual(pendingChoicesFromMessages([current]), ["Ask her", "Wait"]);
  current.swipes[1]!.rawContent = '[CHOICES: []]';
  assert.deepEqual(pendingChoicesFromMessages([current]), []);
  current.swipes[1]!.rawContent = "No raw choices";
  assert.deepEqual(pendingChoicesFromMessages([current]), ["stale A", "stale B"]);
});
