import assert from "node:assert/strict";
import test from "node:test";
import { nextCheckpointName } from "./checkpoint-name.js";

test("checkpoint defaults choose the lowest unused positive number", () => {
  const next = (...names: string[]) => nextCheckpointName(names.map(name => ({ name })));
  assert.equal(next(), "Checkpoint #1");
  assert.equal(next("Chapter 1", "Checkpoint #3"), "Checkpoint #1");
  assert.equal(next("Checkpoint #3", "Checkpoint #1"), "Checkpoint #2");
  assert.equal(next("Checkpoint #1", "Checkpoint #2", "Checkpoint #3"), "Checkpoint #4");
  assert.equal(next(" checkpoint #1 ", "CHECKPOINT #2", "Checkpoint #1"), "Checkpoint #3");
  assert.equal(next("Checkpoint #0", "Checkpoint #01", "Checkpoint #1 notes"), "Checkpoint #1");
});
