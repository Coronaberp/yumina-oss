import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateWorldDefinition, legacyStatusTemplates, type WorldDefinition } from "@yumina/engine";
import { getHybridSkillContent, selectSkills } from "../studio-skills/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveContext } from "./context-resolver.js";
import { executeApplyChanges, executeReadEntities, toolCallsToSchemaChanges } from "./tool-executor.js";

const entry = 'export default function World(){return <Chat />;}';
const config = {
  title: "Status", subtitle: "Current state", accent: "#c8b17e", fields: [{
    id: "health-bar", label: "Health", variableId: "hp", path: "", group: "overview", format: "bar",
    icon: "♥", color: "#a46d5d", min: 0, max: 100, maxVariableId: "", maxPath: "",
  }],
};
const source = `export const statusConfig = ${JSON.stringify(config, null, 2)};`;
function world(files: Record<string, string> = { "index.tsx": entry }): WorldDefinition {
  return {
    id: "status-agent-test", version: "19.0.0", name: "Status test", description: "", author: "test",
    entries: [], variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 84, min: 0, max: 100 }],
    rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    rootComponent: { id: "root", name: "VN", entryFile: "index.tsx", files, updatedAt: "before" },
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition;
}
function call(name: string, args: Record<string, unknown>) {
  return { id: "status-call", function: { name, arguments: JSON.stringify(args) } };
}
function changesFor(current: WorldDefinition, toolCall: ReturnType<typeof call>) {
  return toolCallsToSchemaChanges([toolCall], current).map((parsed) => {
    assert.equal(parsed.error, undefined);
    assert.ok(parsed.change);
    return parsed.change;
  });
}

test("creator agent receives the status visualization format and replacement-sheet contract", () => {
  const { coreSkills } = getHybridSkillContent();
  assert.match(coreSkills, /Player status visualizations/);
  assert.match(coreSkills, /status-config\.ts/);
  assert.match(coreSkills, /valid JSON object/);
  assert.match(coreSkills, /groups:\[/);
  assert.match(coreSkills, /IDs stay stable when labels are renamed/);
  assert.match(coreSkills, /sceneApi\.variables/);
  assert.match(coreSkills, /write_status_visualization\(\{layoutCode\}\)/);
  assert.match(coreSkills, /Custom layout/);
  assert.ok(!coreSkills.includes('For bespoke designs beyond these controls, edit `status-view.tsx`'));
  for (const format of ["gaugeShape", "pipShape", "pipCount", "levelVariableId", "xp-ring", "sceneIcon", "prefers-reduced-motion"]) assert.ok(coreSkills.includes(format), format);
  assert.match(coreSkills, /ENTIRE \*\*right-hand\*\* menu sheet/);
  assert.ok(selectSkills(undefined, "customize the player status visualizations").includes("front-ui"));
  const prompt = buildSystemPrompt({ inventory: "", preloadedEntities: "", tokenEstimate: 0, truncated: false,
    lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0,
      pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } });
  assert.match(prompt.static, /Player status \/ Visualizations/);
  assert.match(prompt.static, /write_status_visualization/);
  assert.match(prompt.static, /follow-up user instructions/);
  assert.match(prompt.static, /groups:\[/);
  assert.match(prompt.static, /\/summarize/);
});

test("status-only requests preload current configuration and retain large-file read hints", async () => {
  const context = await resolveContext(world({
    "index.tsx": `// ${"x".repeat(40000)}\n${entry}`, "status-config.ts": source,
  }), "customize my status", { userId: "test-user", contextWindow: 120000 });
  assert.match(context.preloadedEntities, /health-bar/);
  assert.match(context.inventory, /status-config\.ts/);
  assert.match(context.inventory, /large; read on demand/);
  assert.ok(!context.preloadedEntities.includes("x".repeat(40000)));
});

test("agent can create a .ts status config without overwriting the entry or gameplay variables", () => {
  const original = world();
  const changes = changesFor(original, call("write_custom_ui", { id: "status-config.ts", tsxCode: source }));
  const created = executeApplyChanges(original, changes);
  assert.equal(created.success, true, JSON.stringify(created.results));
  assert.equal(created.world.rootComponent!.files["index.tsx"], entry);
  assert.equal(created.world.rootComponent!.files["status-config.ts"], source);
  assert.deepEqual(created.world.variables, original.variables);
  assert.deepEqual(original.rootComponent!.files, { "index.tsx": entry });
  const edits = changesFor(created.world, call("edit_custom_ui", {
    id: "status-config.ts", old_code: '"label": "Health"', new_code: '"label": "Vitality"',
  }));
  const changed = executeApplyChanges(created.world, edits);
  assert.equal(changed.success, true, JSON.stringify(changed.results));
  assert.equal(changed.world.rootComponent!.files["index.tsx"], entry);
  const literal = changed.world.rootComponent!.files["status-config.ts"]!.replace(/^export const statusConfig = /, "").replace(/;$/, "");
  const edited = JSON.parse(literal);
  assert.equal(edited.fields[0].label, "Vitality");
  assert.equal(edited.fields[0].variableId, "hp");
});

test("missing .ts edits and unsupported filenames fail without falling back to the entry", () => {
  const original = world();
  for (const args of [
    call("edit_custom_ui", { id: "missing.ts", old_code: "<Chat />", new_code: "null" }),
    call("write_custom_ui", { id: "status-config.json", tsxCode: source }),
  ]) {
    const result = executeApplyChanges(original, changesFor(original, args));
    assert.equal(result.success, false);
    assert.match(result.results[0]!.error ?? "", /File.*not found|Unsupported source filename/);
    assert.equal(result.world.rootComponent!.files["index.tsx"], entry);
  }
});


test("agent ingress upgrades older status files before context, reads, writes and resumed loads", async () => {
  const original = world({ "index.tsx": entry, ...legacyStatusTemplates, "status-config.ts": source, "sprites.ts": "authored assets" });
  const current = migrateWorldDefinition(original);
  const files = current.rootComponent!.files;
  assert.ok(files["status-data.ts"]!.includes('"gauge"'));
  assert.ok(files["status-data.ts"]!.includes('"xp-ring"'));
  assert.ok(files["status-gauge.tsx"]); assert.ok(files["status-widgets.tsx"]);
  assert.equal(files["status-config.ts"], source);
  assert.equal(files["sprites.ts"], "authored assets");
  assert.deepEqual(current.variables, original.variables);
  const context = await resolveContext(current, "show my health as a full gauge", { userId: "test-user", contextWindow: 120000 });
  assert.match(context.inventory, /status-gauge\.tsx/);
  assert.match(context.inventory, /status-widgets\.tsx/);
  const read = executeReadEntities(current, ["status-data.ts", "status-gauge.tsx"]);
  assert.equal((read.results["status-data.ts"] as { tsxCode: string }).tsxCode, files["status-data.ts"]);
  assert.equal((read.results["status-gauge.tsx"] as { tsxCode: string }).tsxCode, files["status-gauge.tsx"]);
  const result = executeApplyChanges(current, changesFor(current, call("edit_custom_ui", { id: "status-config.ts", old_code: '"format": "bar"', new_code: '"format": "gauge"' })));
  assert.equal(result.success, true);
  const resumed = migrateWorldDefinition(JSON.parse(JSON.stringify(result.world)));
  assert.ok(resumed.rootComponent!.files["status-config.ts"]!.includes('"format": "gauge"'));
  assert.equal(resumed.rootComponent!.files["status-data.ts"], files["status-data.ts"]);
  assert.equal(original.rootComponent!.files["status-data.ts"], legacyStatusTemplates["status-data.ts"]);
});

test("agent cannot rewrite or delete shipped status helper TypeScript; config edits remain available", () => {
  const current = migrateWorldDefinition(world({ "index.tsx": entry, ...legacyStatusTemplates, "status-config.ts": source }));
  for (const id of ["status-data.ts", "status-gauge.tsx", "status-widgets.tsx"]) {
    for (const change of [
      call("write_custom_ui", { id, tsxCode: "export const broken = true;" }),
      call("edit_custom_ui", { id, old_code: "export", new_code: "// changed export" }),
    ]) {
      const result = executeApplyChanges(current, changesFor(current, change));
      assert.equal(result.success, false);
      assert.match(result.results[0]!.error ?? "", /maintained by Yumina/);
      assert.deepEqual(result.world.rootComponent!.files, current.rootComponent!.files);
    }
    const deleted = executeApplyChanges(current, [{ entityType: "customUI", action: "delete", id }]);
    assert.equal(deleted.success, false);
  }
  const aliasWorld = { ...current, rootComponent: { ...current.rootComponent!, entryFile: "status-data.ts" } };
  const aliasWrite = executeApplyChanges(aliasWorld, changesFor(aliasWorld, call("write_custom_ui", { id: "root-component", tsxCode: "export const broken = true;" })));
  assert.equal(aliasWrite.success, false, "root aliases resolve before checking managed helper protection");
  const authored = world({ "index.tsx": entry, "status-data.ts": "export const custom = true;" });
  const changed = executeApplyChanges(authored, changesFor(authored, call("write_custom_ui", { id: "status-data.ts", tsxCode: "export const custom = false;" })));
  assert.equal(changed.success, true, "authored custom modules retain editing support");
});


test("historical compare replay can show old helper edits without allowing current agent writes", () => {
  const historical = migrateWorldDefinition(world({ "index.tsx": entry, ...legacyStatusTemplates, "status-config.ts": source }), { preserveStatusSources: true });
  const change = changesFor(historical, call("edit_custom_ui", { id: "status-data.ts", old_code: 'export type StatusGroup', new_code: '// historical change\nexport type StatusGroup' }));
  assert.equal(executeApplyChanges(historical, change).success, false);
  const replay = executeApplyChanges(historical, change, { replayHistoricalChanges: true });
  assert.equal(replay.success, true);
  assert.ok(replay.world.rootComponent!.files["status-data.ts"]!.startsWith("// historical change"));
  assert.equal(historical.rootComponent!.files["status-data.ts"], legacyStatusTemplates["status-data.ts"]);
});

test("dedicated visualization tools customize the layout while leaving the renderer and card unchanged", () => {
  const current = migrateWorldDefinition(world({ "index.tsx": entry, ...legacyStatusTemplates, "status-config.ts": source, "sprites.ts": "authored sprites" }));
  const layoutCode = 'export default function StatusLayout({variables}){return <div className="custom-status">{variables.hp}</div>}';
  const created = executeApplyChanges(current, changesFor(current, call("write_status_visualization", { layoutCode })));
  assert.equal(created.success, true, JSON.stringify(created.results));
  assert.equal(created.world.rootComponent!.files["status-layout.tsx"], layoutCode);
  for (const name of ["index.tsx", "status-config.ts", "status-view.tsx", "status-widgets.tsx", "sprites.ts"]) {
    assert.equal(created.world.rootComponent!.files[name], current.rootComponent!.files[name]);
  }
  assert.deepEqual(created.world.variables, current.variables);
  const edited = executeApplyChanges(created.world, changesFor(created.world, call("edit_status_visualization", {
    old_code: 'className="custom-status"', new_code: 'className="relationship-compass"',
  })));
  assert.equal(edited.success, true, JSON.stringify(edited.results));
  assert.ok(edited.world.rootComponent!.files["status-layout.tsx"]!.includes("relationship-compass"));
  const invalid = executeApplyChanges(edited.world, changesFor(edited.world, call("write_status_visualization", { layoutCode: "export default function Broken(){return <div>" })));
  assert.equal(invalid.success, false);
  assert.deepEqual(invalid.world.rootComponent!.files, edited.world.rootComponent!.files);
});

test("managed status view and sheet edits point the agent to the Visualizations layout tools", () => {
  const current = migrateWorldDefinition(world({ "index.tsx": entry, ...legacyStatusTemplates, "status-config.ts": source }));
  for (const id of ["status-view.tsx", "status-sheet.tsx"]) {
    const result = executeApplyChanges(current, changesFor(current, call("write_custom_ui", { id, tsxCode: "export const replaced = true;" })));
    assert.equal(result.success, false);
    assert.match(result.results[0]!.error ?? "", /write_status_visualization/);
    assert.deepEqual(result.world.rootComponent!.files, current.rootComponent!.files);
  }
});
