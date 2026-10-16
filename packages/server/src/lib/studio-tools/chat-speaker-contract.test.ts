import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "./system-prompt.js";
import { getSkillContent } from "../studio-skills/index.js";

test("Studio teaches built-in Chat's engine speaker contract even when TSX instructions are deferred", () => {
  const context = { inventory: "", preloadedEntities: "", tokenEstimate: 0, truncated: false, lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0, pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } };
  for (const contextWindow of [65_536, 1_050_000]) {
    const { static: prompt } = buildSystemPrompt(context, { contextWindow });
    assert.ok(prompt.includes("Built-in Chat parses the engine's per-passage [SPEAKER:Exact Name:emotion] markers"));
    assert.ok(prompt.includes("no custom renderer or switch to VN is needed"));
  }
  assert.ok(getSkillContent("tsx")?.includes("Built-in `<Chat />` reads the engine's `[SPEAKER:Exact Name:emotion]` markers"));
});
