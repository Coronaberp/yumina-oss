import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlock } from "./block.js";
import { type CoreFact } from "./ranking.js";

const fact = (id: string, text: string, extra = {}) => ({ id, text, source: "lore", fact_type: "lore", participants: [], importance: 3, valence: 0, reinforcements: 0, last_turn: 1, valid_until_turn: null, pinned: true, ...extra }) as CoreFact;

test("needed character identity takes priority over the reserved fraction and related profiles", () => {
  const core = fact("sera#identity", "[Character: Sera]\n" + "Age: 247. Instructor. ".repeat(13), { query_matched: true, character_identity: true });
  const related = fact("cinder#0", "[Character: Cinder]\n" + "Optional detail. ".repeat(10));
  const result = buildPromptBlock([core, related], [], [], 500, text => text.length);
  assert.ok(result.usedIds.includes("sera#identity"));
  assert.ok(result.block.length <= 500);
});

test("biography details cannot fit without that character's mandatory identity", () => {
  const core = fact("sera#identity", "Too large. ".repeat(100), { query_matched: true, character_identity: true });
  const detail = fact("sera#1", "Her favorite tea is green.");
  const result = buildPromptBlock([core, detail], [], [], 100, text => text.length);
  assert.doesNotMatch(result.block, /favorite tea/);
});
