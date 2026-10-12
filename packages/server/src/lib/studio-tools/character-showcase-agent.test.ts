import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, executeReadEntities, toolCallsToSchemaChanges } from "./tool-executor.js";
import { WRITE_TOOL_NAMES } from "./tools.js";

const world = {
  id: "showcase-test", version: "21.0.0", name: "Showcase", description: "Public description", author: "test",
  entries: [{ id: "sera", name: "Sera", role: "character", content: "PRIVATE PROFILE", alwaysSend: false, keywords: [], conditions: [], conditionLogic: "all", section: "system-presets", position: 0, enabled: true }],
  variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [],
  settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  rootComponent: { id: "root", name: "Classic", entryFile: "index.tsx", updatedAt: "before", files: { "index.tsx": "authored game", "character-showcase.ts": "authored popup settings", "sprites.ts": "authored sprites" } },
} as WorldDefinition;

function apply(current: WorldDefinition, name: string, args: Record<string, unknown>) {
  const parsed = toolCallsToSchemaChanges([{ id: "showcase-call", function: { name, arguments: JSON.stringify(args) } }], current);
  assert.equal(parsed[0]?.error, undefined);
  assert.ok(parsed[0]?.change);
  return executeApplyChanges(current, [parsed[0].change]);
}

test("Studio updates the published card's HTML and CSS without changing game characters or popup files", () => {
  assert.ok(WRITE_TOOL_NAMES.has("write_card_showcase"));
  assert.ok(WRITE_TOOL_NAMES.has("write_character_showcase_css"));
  const content = apply(world, "write_card_showcase", { html: '<section><h2>Character file</h2><p>Public introduction</p></section>' });
  assert.equal(content.success, true, content.summary);
  const styled = apply(content.world, "write_character_showcase_css", { css: ".card-showcase {background:navy;}" });
  assert.equal(styled.success, true, styled.summary);
  assert.deepEqual(styled.world.cardShowcase, { html: '<section><h2>Character file</h2><p>Public introduction</p></section>', css: ".card-showcase {background:navy;}" });
  assert.deepEqual(styled.world.rootComponent, world.rootComponent);
  assert.deepEqual(styled.world.entries, world.entries);
  assert.ok(!JSON.stringify(styled.world.cardShowcase).includes("PRIVATE PROFILE"));
  assert.deepEqual(executeReadEntities(styled.world, ["card-showcase"]).results["card-showcase"], { _type: "cardShowcase", ...styled.world.cardShowcase });
  assert.equal(world.cardShowcase, undefined);
  const cleared = apply(styled.world, "write_character_showcase_css", { css: "" });
  assert.equal(cleared.success, true);
  assert.equal(cleared.world.cardShowcase?.html, styled.world.cardShowcase?.html);
  assert.equal(cleared.world.cardShowcase?.css, "");
});

test("card showcase editing works without a game interface", () => {
  const result = apply({ ...world, rootComponent: undefined }, "write_card_showcase", { html: "<h1>Card profile</h1>", css: "h1 {color:pink;}" });
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.rootComponent, undefined);
});

test("invalid and obsolete character-targeted showcase calls fail without changing the card", () => {
  for (const [name, args] of [
    ["write_character_showcase_css", { css: "body {}", characterId: "sera" }],
    ["write_card_showcase", {}],
    ["write_card_showcase", { html: 42 }],
    ["write_character_showcase_css", { css: 42 }],
  ] as const) {
    assert.ok(toolCallsToSchemaChanges([{ id: "invalid", function: { name, arguments: JSON.stringify(args) } }], world)[0]?.error);
  }
  const oversized = apply(world, "write_card_showcase", { html: "x".repeat(100001) });
  assert.equal(oversized.success, false);
  assert.deepEqual(oversized.world, world);
});
