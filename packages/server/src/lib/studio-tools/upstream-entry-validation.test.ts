import test from "node:test";
import assert from "node:assert/strict";
import { executeApplyChanges } from "./tool-executor.js";
import type { WorldDefinition } from "@yumina/engine";

function makeWorld(overrides?: Partial<WorldDefinition>): WorldDefinition {
  return {
    id: "test-world",
    version: "19.0.0",
    name: "Test World",
    description: "A test world",
    author: "test",
    entries: [],
    variables: [],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" },
    ...overrides,
  } as WorldDefinition;
}

test("entry writes reject non-string content before mutating lore", () => {
  const original = makeWorld({ entries: [{ id: "lore", name: "Lore", content: "Original", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false }] });
  for (const content of [{ tool_call: { name: "write_entry" } }, ["text"], 42, true, null]) {
    for (const [action, id] of [["create", "new-lore"], ["create", "lore"], ["update", "lore"]] as const) {
      const result = executeApplyChanges(original, [{ action, entityType: "entry", id, data: { content } }]);
      assert.equal(result.success, false);
      assert.match(result.results[0]!.error ?? "", /content.*string/i);
      assert.strictEqual(result.world, original);
      assert.equal(original.entries[0]!.content, "Original");
    }
  }
});

test("entry writes allow empty text and metadata-only updates", () => {
  const created = executeApplyChanges(makeWorld(), [{ action: "create", entityType: "entry", id: "lore", data: { content: "" } }]);
  assert.equal(created.success, true);
  const updated = executeApplyChanges(created.world, [{ action: "update", entityType: "entry", id: "lore", data: { name: "Renamed" } }]);
  assert.equal(updated.success, true);
  assert.equal(updated.world.entries[0]!.content, "");
  assert.equal(updated.world.entries[0]!.name, "Renamed");
});
