import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { executeApplyChanges, toolCallsToSchemaChanges } from "./tool-executor.js";
import { getStructuralPreflight } from "./project-intelligence.js";
import { db } from "../../db/index.js";

// Project intelligence imports the app database indirectly. Close only the
// isolated PGlite client so Node 26 does not exit during its pending shutdown.
after(async () => { if ("close" in db.$client && typeof db.$client.close === "function") await db.$client.close(); });

// The reported Seiryu authoring pattern made presentation conditional on state:
// its SCENE requirement was inside a block ending with an emit-nothing rule.
const conditionalScene = `<variable-updates>
Update tracked variables when the story changes them.
When the location changes, emit [SCENE:ID] using its configured background ID.
Emit nothing if no tracked value changed.
</variable-updates>`;
const separatePresentation = `<variable-updates>
Update tracked variables when the story changes them.
Emit nothing if no tracked value changed.
</variable-updates>
<vn-scene-presentation>
When the location changes, emit [SCENE:ID] using its configured background ID.
</vn-scene-presentation>`;

function entry(content: string): WorldEntry {
  return { id: "variable-update-directive", name: "VariableUpdateDirective", content, role: "custom", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: true };
}

function world(entries: WorldEntry[] = []): WorldDefinition {
  return { id: "authoring-fixture", version: "19.0.0", name: "Authoring fixture", description: "Preserve custom content", author: "Fixture", entries, variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "Player" } } as WorldDefinition;
}

function write(current: WorldDefinition, args: Record<string, unknown>, replayHistoricalChanges = false) {
  const parsed = toolCallsToSchemaChanges([{ id: "fixture-write-entry", function: { name: "write_entry", arguments: JSON.stringify({ id: "variable-update-directive", name: "VariableUpdateDirective", ...args }) } }], current);
  assert.ok(parsed[0]?.change, parsed[0]?.error);
  return executeApplyChanges(current, [parsed[0]!.change!], { replayHistoricalChanges });
}

test("write_entry rejects the reported scene-inside-variable-updates pattern atomically", () => {
  const original = world();
  const result = write(original, { content: conditionalScene });
  assert.equal(result.success, false);
  assert.strictEqual(result.world, original);
  assert.equal(original.entries.length, 0);
  assert.match(result.summary, /SCENE/);
  assert.match(result.summary, /outside.*variable-updates/i);
  assert.match(result.summary, /vn-scene-presentation/);
});

test("changed upserts and direct updates cannot introduce the conditional scene directive", () => {
  const original = world([entry("Only update tracked state when it changes.")]);
  assert.equal(write(original, { content: conditionalScene }).success, false);
  const update = executeApplyChanges(original, [{ action: "update", entityType: "entry", id: "variable-update-directive", data: { content: conditionalScene } }]);
  assert.equal(update.success, false);
  assert.equal(original.entries[0]!.content, "Only update tracked state when it changes.");
  const combined = executeApplyChanges(original, [
    { action: "create", entityType: "entry", id: "valid-entry", data: { name: "Unrelated", content: "Keep this custom lore." } },
    { action: "update", entityType: "entry", id: "variable-update-directive", data: { content: conditionalScene } },
  ]);
  assert.equal(combined.success, false);
  assert.strictEqual(combined.world, original);
  assert.equal(original.entries.length, 1, "A rejected batch does not partially add another entry");
});

test("existing unchanged content and metadata-only edits remain editable without silent rewrites", () => {
  const original = world([entry(conditionalScene)]);
  const unchanged = write(original, { content: conditionalScene, name: "Renamed directive", role: "system" });
  assert.equal(unchanged.success, true);
  assert.equal(unchanged.world.entries[0]!.content, conditionalScene);
  assert.equal(unchanged.world.entries[0]!.name, "Renamed directive");
  const metadata = executeApplyChanges(original, [{ action: "update", entityType: "entry", id: "variable-update-directive", data: { enabled: false, role: "custom" } }]);
  assert.equal(metadata.success, true);
  assert.equal(metadata.world.entries[0]!.content, conditionalScene);
  assert.equal(original.entries[0]!.enabled, true, "Input content and metadata are not mutated");
  assert.equal(write(original, { content: `${conditionalScene}\nA new instruction.` }).success, false, "Changed content must resolve the conflict");
});

test("separate scene presentation, ordinary SCENE greetings, and state-only directives pass", () => {
  for (const content of [
    separatePresentation,
    "[SCENE:Courtyard]\nThe first school bell rings.",
    "<variable-updates>Emit nothing if no tracked value changed.</variable-updates>",
    "<variable-updates>State only.</variable-updates>\n[SCENE:Classroom]",
    "<task>Describe the academy. [SCENE:Courtyard]", // Unclosed unrelated tags are outside this narrow guard.
    "<variable-updates-example>[SCENE:Classroom]</variable-updates-example>",
    "<variable-updates/>\n[SCENE:Courtyard]",
  ]) assert.equal(write(world(), { content }).success, true, content);
  const corrected = write(world([entry(conditionalScene)]), { content: separatePresentation });
  assert.equal(corrected.success, true, "The conflict can be repaired explicitly");
});

test("unclosed, nested, case-insensitive, and repeated variable-update scopes cannot hide SCENE markers", () => {
  for (const content of [
    "<variable-updates>Emit nothing if unchanged. [SCENE:Classroom]",
    "<variable-updates><variable-updates>State only.</variable-updates>[SCENE:Classroom]</variable-updates>",
    '<VARIABLE-UPDATES mode="conditional">Emit nothing if unchanged. [scene:Classroom]</VARIABLE-UPDATES>',
    "<variable-updates>State only.</variable-updates><variable-updates>Emit [SCENE:Classroom].</variable-updates>",
    "<variable-updates>Emit [SCENE:Classroom", // Even an incomplete presentation marker must be moved out.
  ]) assert.equal(write(world(), { content }).success, false, content);
});

test("historical comparison replay remains possible without authoring an invalid new directive", () => {
  const current = world();
  assert.equal(write(current, { content: conditionalScene }, true).success, true);
  assert.equal(write(current, { content: conditionalScene }).success, false);
});

test("structural preflight warns on the existing directive conflict without rewriting or blocking old cards", () => {
  const current = world([entry(conditionalScene)]);
  const before = structuredClone(current);
  const report = getStructuralPreflight(current);
  const finding = report.warnings.find(item => item.code === "scene-in-variable-updates");
  assert.ok(finding);
  assert.equal(finding.entityId, "variable-update-directive");
  assert.equal(finding.severity, "warning");
  assert.match(finding.fix ?? "", /outside.*variable-updates/i);
  assert.equal(report.blockingErrors.some(item => item.code === "scene-in-variable-updates"), false);
  assert.deepEqual(current, before);
});

test("structural preflight does not flag corrected presentation or unrelated tag syntax", () => {
  for (const content of [separatePresentation, "[SCENE:Courtyard] Welcome.", "<task>Unclosed unrelated author tag", "<variable-updates>State only.</variable-updates>"]) {
    assert.equal(getStructuralPreflight(world([entry(content)])).warnings.some(item => item.code === "scene-in-variable-updates"), false, content);
  }
});
