import assert from "node:assert/strict";
import test from "node:test";
import { stripGameStateDump } from "../../../../engine/src/parser/response-metadata";

test("state snapshot filtering preserves ordinary prose and accepts paired XML or bracket wrappers", () => {
  const prose = "The game-state is displayed in the menu.\n[health: -1]";
  assert.equal(stripGameStateDump(prose), prose);
  assert.equal(stripGameStateDump("Before\n<game-state>\na: 1\n</game-state>\nAfter"), "Before\n\nAfter");
  assert.equal(stripGameStateDump("Before\n[game-state]\na: 1\n[/game-state]\nAfter"), "Before\n\nAfter");
});

test("an unmatched state opener cannot swallow later narrative", () => {
  const content = "[game-state]\nacademy-day: 1\n*The clerk waits.*";
  assert.equal(stripGameStateDump(content), content);
});
