import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "./system-prompt.js";
import { getSkillContent } from "../studio-skills/index.js";

test("a small endpoint uses an on-demand skill catalog instead of sending every helper manual", () => {
  const parts = buildSystemPrompt({ inventory: "Entry: current-character", preloadedEntities: "Current character content", tokenEstimate: 10, truncated: false,
    lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0, pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } }, { contextWindow: 65536 });
  assert.ok(parts.static.length < 40000, "Core instructions leave room for tools, task context and output");
  assert.ok(parts.world.includes("Current character content"));
  for (const name of ["entries", "variables", "tsx", "front-ui", "world-design", "rules"]) {
    assert.ok(parts.static.includes(`- ${name}:`), `${name} is discoverable`);
    assert.ok(getSkillContent(name), `${name} remains available through load_skill`);
  }
});
