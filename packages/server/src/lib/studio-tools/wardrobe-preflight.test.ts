import assert from "node:assert/strict";
import test from "node:test";
import { worldDefinitionSchema, type WorldDefinition } from "@yumina/engine";
import { executeValidateWorld } from "./tool-executor.js";
import { getStructuralPreflight } from "./project-intelligence.js";

function world(content: string, role: WorldDefinition["entries"][number]["role"] = "character"): WorldDefinition {
  return worldDefinitionSchema.parse({
    id: "wardrobe-preflight", name: "Wardrobe preflight", version: "20.0.0",
    description: "Wardrobe validation fixture", author: "Test", settings: {},
    entries: [{ id: "alice", name: "Alice", role, content, section: "system-presets", enabled: true }],
  });
}
const undefinedMacros = (card: WorldDefinition) => executeValidateWorld(card, { skipTsx: true })
  .issues.filter(issue => issue.code === "entry-undefined-macro");

test("character wardrobe runtime placeholder needs no authored variable", () => {
  const card = world("Clothing: {{sprite_wardrobe}} / {{ SPRITE_WARDROBE }}");
  const before = structuredClone(card);
  assert.deepEqual(undefinedMacros(card), []);
  assert.deepEqual(card, before);
});

test("shared play/export preflight accepts runtime wardrobe after native JSON round trip", () => {
  const card = worldDefinitionSchema.parse(JSON.parse(JSON.stringify(world("{{sprite_wardrobe}}"))));
  const report = getStructuralPreflight(card);
  assert.equal(report.warnings.some(issue => issue.code === "entry-undefined-macro"), false);
  assert.equal(card.variables.some(variable => variable.id === "sprite_wardrobe"), false);
});

test("noncharacter wardrobe placeholders retain the undefined-macro warning", () => {
  for (const role of ["system", "personality", "scenario", "lore", "plot", "style", "example", "greeting", "custom"] as const) {
    const card = world("{{sprite_wardrobe}}", role);
    const issues = undefinedMacros(card);
    assert.equal(issues.length, 1, role);
    assert.match(issues[0]!.message, /no variable named "sprite_wardrobe"/);
    assert.equal(getStructuralPreflight(card).warnings.filter(issue => issue.code === "entry-undefined-macro").length, 1, role);
  }
});

test("typos and explicit variable references are still validated", () => {
  const unresolved = world("{{sprite_wardobe}} {{var:sprite_wardrobe}} {{unknown}}");
  const issues = undefinedMacros(unresolved);
  assert.equal(issues.length, 3);
  assert.equal(getStructuralPreflight(unresolved).warnings.filter(issue => issue.code === "entry-undefined-macro").length, 3);
  const card = world("{{var:sprite_wardrobe}} {{sprite_wardrobe}}");
  card.variables.push({ id: "sprite_wardrobe", name: "Custom wardrobe", type: "string", defaultValue: "coat", behaviorRules: "Authored custom value." });
  assert.deepEqual(undefinedMacros(card), []);
});
