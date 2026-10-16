import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUsage, getContextBudget } from "./context-tokens";

test("Codex Luna uses its known context window instead of the unknown-model fallback", () => {
  for (const model of ["codex/gpt-6-luna", "gpt-6-luna", "CODEX/GPT-6-LUNA"]) {
    const budget = getContextBudget(model);
    assert.equal(budget, 630_000);
    const usage = classifyUsage(225_000, budget);
    assert.equal(usage.health, "comfortable");
    assert.equal(Math.round(usage.percent), 36);
  }
  assert.equal(getContextBudget("unknown-model"), 120_000);
  assert.equal(getContextBudget("custom/deepseek-flash"), 50_000);
});
