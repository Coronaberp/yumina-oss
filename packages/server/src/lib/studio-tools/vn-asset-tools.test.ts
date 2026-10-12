import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VN_BACKGROUND_TEMPLATE, readVnAssetMap, readVnOpeningScenes, readVnNpcSpritePools, type WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, toolCallsToSchemaChanges } from "./tool-executor.js";
import { executeListVnAssets } from "./vn-asset-tools.js";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "./tools.js";
import { getHybridSkillContent } from "../studio-skills/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

function world(): WorldDefinition {
  return {
    id: "vn-agent-test", version: "19.0.0", name: "VN test", description: "", author: "test",
    entries: [{ id: "opening-one", name: "First opening", role: "greeting", content: "Hi", enabled: true }],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    rootComponent: { id: "root", name: "VN", interfaceId: "vn", entryFile: "index.tsx", updatedAt: "before", files: {
      "index.tsx": "export default function World(){return <Chat />;}",
      "sprites.ts": 'export const sprites = { "Alice": { "normal": "@asset:old" }, "Bob": { "normal": "@asset:bob" } };\n// Keep authored runtime\nexport const npcSprites = { "male": {}, "female": {} };\nexport function npcSpriteFor() { return null; }\nexport function npcSpriteSelection() { return null; }',
      "scenes.ts": VN_BACKGROUND_TEMPLATE,
    } },
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition;
}
function calls(...args: Array<Record<string, unknown>>) {
  return args.map((arg, index) => ({ id: `call-${index}`, function: { name: "edit_vn_assets", arguments: JSON.stringify(arg) } }));
}
function apply(current: WorldDefinition, ...args: Array<Record<string, unknown>>) {
  const parsed = toolCallsToSchemaChanges(calls(...args), current);
  for (const item of parsed) assert.equal(item.error, undefined);
  const result = executeApplyChanges(current, parsed.map(item => item.change!));
  assert.equal(result.success, true, JSON.stringify(result.results));
  return result.world;
}

test("two assignments parsed together accumulate and retain authored source", () => {
  const original = world();
  const changed = apply(original,
    { kind: "sprites", action: "assign", name: "Alice", variant: "happy", assetRef: "@asset:happy" },
    { kind: "sprites", action: "assign", name: "Alice", variant: "sad", assetRef: "@asset:sad" });
  assert.deepEqual(readVnAssetMap(changed.rootComponent!.files["sprites.ts"]!, "sprites").Alice,
    { normal: "@asset:old", happy: "@asset:happy", sad: "@asset:sad" });
  assert.match(changed.rootComponent!.files["sprites.ts"]!, /Keep authored runtime/);
  assert.equal(changed.rootComponent!.files["index.tsx"], original.rootComponent!.files["index.tsx"]);
  assert.equal(readVnAssetMap(original.rootComponent!.files["sprites.ts"]!, "sprites").Alice instanceof Object, true);
  assert.ok(!original.rootComponent!.files["sprites.ts"]!.includes("@asset:happy"));
});

test("opening and Global scene/default assignments are isolated", () => {
  const changed = apply(world(),
    { kind: "backgrounds", action: "assign", name: "garden", assetRef: "@asset:global" },
    { kind: "backgrounds", action: "set_default", assetRef: "@asset:global-default" },
    { kind: "backgrounds", action: "assign", openingId: "opening-one", name: "garden", variant: "night", assetRef: "@asset:opening" },
    { kind: "backgrounds", action: "set_default", openingId: "opening-one", assetRef: "@asset:opening-default" });
  const source = changed.rootComponent!.files["scenes.ts"]!;
  assert.deepEqual(readVnAssetMap(source, "backgrounds"), { garden: { day: "@asset:global" }, default: "@asset:global-default" });
  assert.deepEqual(readVnOpeningScenes(source), { "opening-one": { garden: { night: "@asset:opening" }, default: "@asset:opening-default" } });
  const cleared = apply(changed, { kind: "backgrounds", action: "clear_default", openingId: "opening-one" });
  assert.equal(readVnOpeningScenes(cleared.rootComponent!.files["scenes.ts"]!)["opening-one"]!.default, undefined);
  assert.deepEqual(readVnAssetMap(cleared.rootComponent!.files["scenes.ts"]!, "backgrounds"), readVnAssetMap(source, "backgrounds"));
});

test("inventory exposes stable opening/row IDs, defaults, and help with pagination", () => {
  const inventory = executeListVnAssets(world(), { kind: "sprites", limit: 1 });
  assert.equal(inventory.editable, true);
  assert.equal(inventory.nextOffset, 1);
  assert.equal(inventory.rows![0]!.id, '["Alice","normal"]');
  assert.equal(inventory.openings[0]!.id, "opening-one");
  assert.match(inventory.help!, /Settings/);
  const missing = executeListVnAssets(world(), { kind: "backgrounds", openingId: "missing" });
  assert.equal(missing.editable, false);
  assert.match(missing.error!, /Opening not found/);
});

test("subset reorder preserves hidden cards and stores inert metadata", () => {
  const original = apply(world(), { kind: "sprites", action: "assign", name: "Alice", variant: "happy", assetRef: "@asset:happy" });
  const changed = apply(original, { kind: "sprites", action: "reorder", order: ['["Alice","happy"]', '["Alice","normal"]'] });
  assert.deepEqual(executeListVnAssets(changed, { kind: "sprites" }).rows!.map(row => row.name + ":" + row.variant), ["Alice:happy", "Alice:normal", "Bob:normal"]);
  assert.equal(changed.rootComponent!.files["sprites.ts"], original.rootComponent!.files["sprites.ts"]);
  assert.ok(changed.rootComponent!.files["vn-asset-order.json"]);
});

test("NPC sprites and fallback controls remain accessible to the agent", () => {
  const changed = apply(world(),
    { kind: "sprites", action: "assign", npcGender: "female", name: "student", assetRef: "@asset:student" },
    { kind: "sprites", action: "configure_npc_defaults", mode: "a", disabled: true });
  assert.deepEqual(readVnNpcSpritePools(changed.rootComponent!.files["sprites.ts"]!).female, { student: "@asset:student" });
  assert.equal(executeListVnAssets(changed, { kind: "sprites", npcGender: "female" }).rows![0]!.id, '["female","student"]');
  assert.deepEqual(executeListVnAssets(changed, { kind: "sprites" }).npcDefaults, { mode: "a", disabled: true });
  const removed = apply(changed, { kind: "sprites", action: "remove", npcGender: "female", name: "student" });
  assert.deepEqual(readVnNpcSpritePools(removed.rootComponent!.files["sprites.ts"]!).female, {});
});

test("custom maps and invalid scope fail without mutating the original", () => {
  const original = world();
  original.rootComponent!.files["sprites.ts"] = 'export const sprites = loadCustomSprites();';
  const parsed = toolCallsToSchemaChanges(calls({ kind: "sprites", action: "assign", name: "Alice", assetRef: "@asset:new" }), original);
  const result = executeApplyChanges(original, [parsed[0]!.change!]);
  assert.equal(result.success, false);
  assert.match(result.results[0]!.error!, /custom code/);
  assert.deepEqual(result.world, original);
  for (const input of [
    { kind: "sprites", action: "assign", openingId: "opening-one", name: "Alice", assetRef: "@asset:new" },
    { kind: "backgrounds", action: "assign", name: "garden", assetRef: "data:image/png;base64,abc" },
    { kind: "backgrounds", action: "set_default", npcGender: "male", assetRef: "@asset:new" },
  ]) assert.ok(toolCallsToSchemaChanges(calls(input), world())[0]!.error);
});

test("known legacy background resolver upgrades for opening assignments", () => {
  const original = world();
  original.rootComponent!.files["scenes.ts"] = `export const scenes = {};
export function backgroundFor(api, line) {
  const scene = scenes[line?.scene || api.variables?.["current-scene"]];
  return (typeof scene === "string" ? scene : scene?.[api.variables?.["current-period"]] || scene?.day)
    || api.variables?.["scene-bg"] || api.variables?.scene_bg || api.variables?.current_bg;
}`;
  const changed = apply(original, { kind: "backgrounds", action: "assign", openingId: "opening-one", name: "garden", assetRef: "@asset:opening" });
  assert.match(changed.rootComponent!.files["scenes.ts"]!, /activeGreetingId/);
  assert.deepEqual(readVnOpeningScenes(changed.rootComponent!.files["scenes.ts"]!), { "opening-one": { garden: { day: "@asset:opening" } } });
});

test("agent receives VN tools and help and the packaged resolver matches the actual interface", () => {
  assert.equal(READ_TOOL_NAMES.has("list_vn_assets"), true);
  assert.equal(WRITE_TOOL_NAMES.has("edit_vn_assets"), true);
  const { coreSkills } = getHybridSkillContent();
  assert.match(coreSkills, /Visual Novel sprites and backgrounds/);
  assert.match(coreSkills, /Danbooru/);
  const prompt = buildSystemPrompt({ inventory: "", preloadedEntities: "", tokenEstimate: 0, truncated: false,
    lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0, pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } });
  assert.match(prompt.static, /edit_vn_assets/);
  assert.equal(VN_BACKGROUND_TEMPLATE, readFileSync(new URL("../../../../../interfaces/vn/scenes.ts", import.meta.url), "utf8"));
});
