import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VN_BACKGROUND_TEMPLATE, readVnAssetMap, readVnOpeningScenes, readVnNpcSpritePools, readVnSpriteSets, type WorldDefinition } from "@yumina/engine";
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

test("wardrobe descriptions use built-in batches and list description-only characters", () => {
  const original = world();
  const changed = apply(original,
    { kind: "sprites", action: "add_option", optionKind: "types", label: "Uniform" },
    { kind: "sprites", action: "set_wardrobe_description", name: "Alice", spriteType: "uniform", description: "A blue blazer and silver boots." },
    { kind: "sprites", action: "set_wardrobe_description", name: "Clara", spriteType: "normal", description: "A green dress." });
  const inventory = executeListVnAssets(changed, { kind: "sprites", name: "alice", spriteType: "uniform" });
  assert.deepEqual(inventory.wardrobeDescriptions, [{ name: "Alice", spriteType: "uniform", spriteVariant: "", description: "A blue blazer and silver boots." }]);
  assert.deepEqual(inventory.characters, ["Alice"]);
  assert.ok(executeListVnAssets(changed, { kind: "sprites" }).characters?.includes("Clara"));
  assert.deepEqual(readVnSpriteSets(changed.rootComponent!.files["sprites.ts"]!), readVnSpriteSets(original.rootComponent!.files["sprites.ts"]!));
  const cleared = apply(changed, { kind: "sprites", action: "set_wardrobe_description", name: "alice", spriteType: "uniform", description: "" });
  assert.deepEqual(executeListVnAssets(cleared, { kind: "sprites", name: "Alice" }).wardrobeDescriptions, []);
});

test("wardrobe description operations reject missing fields and incompatible scopes", () => {
  for (const args of [
    { kind: "sprites", action: "set_wardrobe_description", name: "Alice", description: "Coat" },
    { kind: "sprites", action: "set_wardrobe_description", name: "Alice", spriteType: "normal" },
    { kind: "sprites", action: "set_wardrobe_description", npcGender: "male", name: "Alice", spriteType: "normal", description: "Coat" },
    { kind: "backgrounds", action: "set_wardrobe_description", name: "Alice", spriteType: "normal", description: "Coat" },
  ]) assert.ok(toolCallsToSchemaChanges(calls(args), world())[0]?.error);
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


test("typed assignments and catalog edits preserve Normal and expose card-specific options", () => {
  const changed = apply(world(),
    { kind: "sprites", action: "add_option", optionKind: "types", label: "Battle Wear" },
    { kind: "sprites", action: "add_option", optionKind: "emotions", label: "Embarrassed" },
    { kind: "sprites", action: "assign", name: "Alice", spriteType: "battle-wear", variant: "embarrassed", assetRef: "@asset:battle" });
  const source = changed.rootComponent!.files["sprites.ts"]!;
  assert.deepEqual(readVnAssetMap(source, "sprites").Alice, { normal: "@asset:old" });
  assert.deepEqual(readVnSpriteSets(source)["battle-wear"]!.Alice, { embarrassed: "@asset:battle" });
  const inventory = executeListVnAssets(changed, { kind: "sprites", spriteType: "battle-wear" });
  assert.equal(inventory.spriteConfig!.types["battle-wear"], "Battle Wear");
  assert.equal(inventory.spriteConfig!.emotions.embarrassed, "Embarrassed");
  assert.equal(inventory.rows![0]!.spriteType, "battle-wear");
  assert.equal(inventory.rows![0]!.id, '["battle-wear","Alice","embarrassed"]');
  const renamed = apply(changed, { kind: "sprites", action: "rename_option", optionKind: "types", optionId: "battle-wear", label: "Battle Uniform" });
  assert.equal(executeListVnAssets(renamed, {}).spriteConfig!.types["battle-wear"], "Battle Uniform");
  const removed = apply(renamed, { kind: "sprites", action: "remove_option", optionKind: "types", optionId: "battle-wear" });
  assert.equal(readVnSpriteSets(removed.rootComponent!.files["sprites.ts"]!)["battle-wear"], undefined);
  assert.deepEqual(readVnAssetMap(removed.rootComponent!.files["sprites.ts"]!, "sprites"), readVnAssetMap(source, "sprites"));
});

test("sprite options reject incompatible scopes and protect built-ins", () => {
  for (const input of [
    { kind: "backgrounds", action: "add_option", optionKind: "types", label: "Battle" },
    { kind: "sprites", action: "assign", npcGender: "male", name: "guard", spriteType: "battle", assetRef: "@asset:guard" },
    { kind: "backgrounds", action: "assign", name: "garden", spriteType: "normal", assetRef: "@asset:garden" },
    { kind: "sprites", action: "add_option", optionKind: "types" },
  ]) assert.ok(toolCallsToSchemaChanges(calls(input), world())[0]!.error);
  const original = world();
  const parsed = toolCallsToSchemaChanges(calls({ kind: "sprites", action: "remove_option", optionKind: "emotions", optionId: "normal" }), original);
  assert.equal(executeApplyChanges(original, [parsed[0]!.change!]).success, false);
});


test("Studio caps and warning use the card's own catalog", () => {
  let current = world();
  for (let index = 0; index < 6; index++) current = apply(current, { kind: "sprites", action: "add_option", optionKind: "types", label: `Outfit ${index}` });
  for (let index = 0; index < 14; index++) current = apply(current, { kind: "sprites", action: "add_option", optionKind: "emotions", label: `Emotion ${index}` });
  assert.equal(executeListVnAssets(current, {}).warnings!.length, 1);
  assert.equal(Object.keys(executeListVnAssets(world(), {}).spriteConfig!.types).length, 1);
  const parsed = toolCallsToSchemaChanges(calls({ kind: "sprites", action: "add_option", optionKind: "types", label: "More outfits" }), current);
  assert.equal(executeApplyChanges(current, [parsed[0]!.change!]).success, true);
  for (let index = 14; index < 24; index++) current = apply(current, { kind: "sprites", action: "add_option", optionKind: "emotions", label: `Emotion ${index}` });
  const overflow = toolCallsToSchemaChanges(calls({ kind: "sprites", action: "add_option", optionKind: "emotions", label: "Overflow" }), current);
  assert.equal(executeApplyChanges(current, [overflow[0]!.change!]).success, false);
});

test("typed subset reorder preserves rows hidden in another wardrobe", () => {
  const current = apply(world(),
    { kind: "sprites", action: "add_option", optionKind: "types", label: "Battle" },
    { kind: "sprites", action: "assign", name: "Alice", spriteType: "battle", variant: "happy", assetRef: "@asset:battlehappy" },
    { kind: "sprites", action: "assign", name: "Alice", spriteType: "battle", variant: "sad", assetRef: "@asset:battlesad" });
  const rows = executeListVnAssets(current, { spriteType: "battle" }).rows!;
  const changed = apply(current, { kind: "sprites", action: "reorder", spriteType: "battle", order: rows.map(row => row.id).reverse() });
  assert.equal(executeListVnAssets(changed, {}).rows!.length, 4);
  assert.equal(JSON.parse(changed.rootComponent!.files["vn-asset-order.json"]!)["sprites:character"].length, 4);
});

test("variant tools isolate assignments, descriptions, inventory and stable row IDs", () => {
  let current = apply(world(), { kind: "sprites", action: "add_variant", spriteType: "normal", label: "Rain coat" });
  current = apply(current,
    { kind: "sprites", action: "assign", name: "Alice", spriteType: "normal", spriteVariant: "rain-coat", variant: "normal", assetRef: "@asset:rain" },
    { kind: "sprites", action: "set_wardrobe_description", name: "Alice", spriteType: "normal", spriteVariant: "rain-coat", description: "A red rain coat." });
  const variant = executeListVnAssets(current, { name: "Alice", spriteType: "normal", spriteVariant: "rain-coat" });
  assert.equal(variant.editable, true);
  if (!variant.editable || !("rows" in variant)) throw Error("Expected editable inventory");
  assert.equal(variant.rows!.length, 1);
  assert.equal(variant.rows![0]!.assetRef, "@asset:rain");
  assert.equal(variant.wardrobeDescriptions![0]!.description, "A red rain coat.");
  assert.deepEqual(variant.outfits![0]!.availableExpressions, ["normal"]);
  assert.equal(variant.spriteLimits!.types, null);
  const base = executeListVnAssets(current, { name: "Alice", spriteType: "normal", spriteVariant: "" });
  if (!("rows" in base)) throw Error("Expected base inventory");
  assert.notEqual(base.rows![0]!.id, variant.rows![0]!.id);
  current = apply(current, { kind: "sprites", action: "remove", name: "Alice", spriteType: "normal", spriteVariant: "rain-coat", variant: "normal" });
  assert.deepEqual(readVnSpriteSets(current.rootComponent!.files["sprites.ts"]!).normal!.Alice, { normal: "@asset:old" });
});

test("chapter outfit tools use separate greeting scope without changing shared assignment scope", () => {
  let current = apply(world(), { kind: "sprites", action: "set_chapter_outfit", chapterOpeningId: "opening-one", name: "Alice", spriteType: "normal" });
  assert.match(current.rootComponent!.files["sprites.ts"]!, /spriteChapterDefaults/);
  current = apply(current, { kind: "sprites", action: "clear_chapter_outfit", chapterOpeningId: "opening-one", name: "Alice" });
  const invalid = toolCallsToSchemaChanges(calls({ operations: [
    { kind: "sprites", action: "assign", name: "Alice", assetRef: "@asset:new" },
    { kind: "sprites", action: "set_chapter_outfit", name: "Alice", spriteType: "normal" },
  ] }), current);
  assert.ok(invalid[0]!.error);
});

 test("outfit and wardrobe catalogs use bounded independent pagination", () => {
  let source = world();
  for (let index = 0; index < 12; index++) source = apply(source, { kind: "sprites", action: "add_option", optionKind: "types", label: "Outfit " + index });
  const first = executeListVnAssets(source, { limit: 5 });
  assert.equal(first.spriteTypeTotal, 13);
  assert.equal(first.nextSpriteTypeOffset, 5);
  assert.equal(Object.keys(first.spriteConfig!.types).length, 5);
  const next = executeListVnAssets(source, { offset: 5, limit: 5 });
  assert.equal(Object.keys(next.spriteConfig!.types).length, 5);
  assert.equal(Object.keys(next.spriteConfig!.types).some(id => Object.hasOwn(first.spriteConfig!.types, id)), false);
});
