import assert from "node:assert/strict";
import test from "node:test";
import type { RootComponent } from "@yumina/engine";
import { isVnInterface, readVnAssetMap, writeVnAssetMap, assignVnAsset, removeVnAsset, vnAssetRows, vnCharacterNames, readVnNpcSpritePools, writeVnNpcSpritePools, assignVnNpcSprite, removeVnNpcSprite } from "./vn-assets";
import { readVnNpcDefaults, writeVnNpcDefaults, readVnNpcDefaultSpritePools } from "./vn-assets";
import { readFileSync } from "node:fs";
import { readVnOpeningScenes, writeVnOpeningScenes, readVnAssetOrders, orderedVnAssetRows, reorderVnAssetRows, vnAssetRowId, VN_ASSET_ORDER_FILE } from "./vn-assets";
import { bundleTSX } from "../../studio/lib/tsx-bundler";

const spriteSource = '// Custom comment\nexport const sprites = { Miveth: { normal: "@asset:old" } };\nexport function spriteFor() { return sprites; }\n';
const sceneSource = 'export const scenes = {};\nexport function backgroundFor(api, line) {\n  const scene = scenes[line?.scene || api.variables?.["current-scene"]];\n  return (typeof scene === "string" ? scene : scene?.[api.variables?.["current-period"]] || scene?.day)\n    || api.variables?.["scene-bg"] || api.variables?.scene_bg || api.variables?.current_bg;\n}\n';
const sceneTemplate = readFileSync(new URL("../../../../../../interfaces/vn/scenes.ts", import.meta.url), "utf8");

test("sprite ordering crosses character groups without changing assignments and preserves filtered-out slots", () => {
  const map = { Diane: { normal: "@asset:d1", happy: "@asset:d2" }, Kei: { normal: "@asset:k1", happy: "@asset:k2" } };
  const rows = vnAssetRows(map, "sprites");
  const before = structuredClone(map);
  const moved = reorderVnAssetRows(rows, rows, vnAssetRowId(rows[0]), vnAssetRowId(rows[2]));
  assert.deepEqual(moved.map(vnAssetRowId), [rows[1], rows[2], rows[0], rows[3]].map(vnAssetRowId));
  const visible = moved.filter(row => row.name === "Diane");
  const filtered = reorderVnAssetRows(moved, visible, vnAssetRowId(visible[0]), vnAssetRowId(visible[1]));
  assert.deepEqual(filtered, [rows[0], rows[2], rows[1], rows[3]]);
  assert.deepEqual(map, before);
  const persisted = readVnAssetOrders(JSON.stringify({ "sprites:character": filtered.map(vnAssetRowId), "backgrounds:global": [] }));
  assert.deepEqual(orderedVnAssetRows(rows, persisted["sprites:character"]), filtered);
  assert.deepEqual(orderedVnAssetRows([...rows, { name: "New", variant: "normal", assetRef: "@asset:new" }], [...persisted["sprites:character"], "deleted"]), [...filtered, { name: "New", variant: "normal", assetRef: "@asset:new" }]);
  assert.equal(reorderVnAssetRows(rows, rows, "missing", vnAssetRowId(rows[0])), rows);
  assert.notEqual(vnAssetRowId({ name: "A:B", variant: "C", assetRef: "a" }), vnAssetRowId({ name: "A", variant: "B:C", assetRef: "a" }));
});

test("editor order metadata stays outside the runtime compilation and rejects malformed orders", () => {
  for (const source of ['[]', 'null', '{"sprites:character":42}', '{"sprites:character":["a","a"]}']) assert.throws(() => readVnAssetOrders(source));
  const result = bundleTSX({ entryFile: "index.tsx", files: { "index.tsx": "export default function Card() { return <div />; }", [VN_ASSET_ORDER_FILE]: '{"sprites:character":["example"]}' } });
  assert.equal(result.error, null);
  assert.ok(!result.code?.includes("sprites:character"));
});

test("opening background collections preserve Global, other openings, and surrounding custom code", () => {
  const global = assignVnAsset({}, "opening", "day", "@asset:global", "day");
  global.default = "@asset:global";
  const source = '// authored prefix\n' + writeVnAssetMap(sceneSource, "backgrounds", global) + '\n// authored suffix\n';
  const first = writeVnOpeningScenes(source, "greeting-one", { opening: { day: "@asset:one", night: "@asset:one-night" }, default: "@asset:one" }, sceneTemplate);
  const second = writeVnOpeningScenes(first, "greeting-two", { opening: { day: "@asset:two" } }, sceneTemplate);
  assert.deepEqual(readVnAssetMap(second, "backgrounds"), global);
  assert.deepEqual(readVnOpeningScenes(second), { "greeting-one": { opening: { day: "@asset:one", night: "@asset:one-night" }, default: "@asset:one" }, "greeting-two": { opening: { day: "@asset:two" } } });
  assert.ok(second.startsWith('// authored prefix\n'));
  assert.ok(second.includes('// authored suffix\n'));
  const changedGlobal = writeVnAssetMap(second, "backgrounds", { ...global, default: "@asset:new-global" });
  assert.deepEqual(readVnOpeningScenes(changedGlobal), readVnOpeningScenes(second));
  const removed = writeVnOpeningScenes(second, "greeting-one", {}, sceneTemplate);
  assert.deepEqual(readVnOpeningScenes(removed), { "greeting-two": { opening: { day: "@asset:two" } } });
  assert.deepEqual(readVnAssetMap(removed, "backgrounds"), global);
  assert.throws(() => writeVnOpeningScenes('export const scenes = {};\nexport function backgroundFor(api, line) { return custom(api, line); }', "one", { default: "@asset:one" }, sceneTemplate));
  assert.throws(() => readVnOpeningScenes('export const openingScenes = loadBackgrounds();'));
});

test("opening backgrounds use stable IDs after pruning and fall back to Global independently", () => {
  const source = writeVnOpeningScenes(writeVnAssetMap(sceneTemplate, "backgrounds", { opening: { day: "global-opening" }, garden: { day: "global-garden" }, default: "global-default" }), "one", { opening: { day: "one-day", night: "one-night" }, default: "one-default" }, sceneTemplate);
  const withTwo = writeVnOpeningScenes(writeVnOpeningScenes(source, "two", { opening: "two-opening" }, sceneTemplate), "blank", { default: "blank-route" }, sceneTemplate);
  // Execute only our known runtime template, after data-only writers validated its maps.
  const resolve = new Function(withTwo.replace(/export /g, "") + '\nreturn backgroundFor;')() as (api: Record<string, unknown>, line?: { scene?: string }) => string;
  const entries = [{ id: "two", name: "Second", role: "greeting", enabled: true, position: 2 }, { id: "one", role: "greeting", enabled: true, position: 1 }];
  const api = { entries, variables: {}, hasEarlierMessages: false, messages: [{ role: "assistant", activeSwipeIndex: 0 }] };
  assert.equal(resolve(api), "one-day", "an untagged opening uses its own opening art before defaults");
  assert.equal(resolve({ ...api, messages: [{ role: "assistant", activeSwipeIndex: 1 }] }), "two-opening", "opening art does not require a collection default");
  assert.equal(resolve({ ...api, variables: { "current-period": "night" } }, { scene: "" }), "one-night", "an empty scene still selects the opening period");
  assert.equal(resolve(api, { scene: "opening" }), "one-day");
  assert.equal(resolve({ ...api, messages: [{ role: "assistant", activeSwipeIndex: 1 }] }, { scene: "opening" }), "two-opening");
  const pruned = { ...api, hasEarlierMessages: true, messages: [{ role: "assistant", stateSnapshot: null }, { role: "assistant", stateSnapshot: { activeGreetingId: "one" } }, { role: "user" }] };
  assert.equal(resolve(pruned), "one-day", "snapshot identity also selects untagged opening art");
  assert.equal(resolve(pruned, { scene: "opening" }), "one-day");
  assert.equal(resolve({ ...pruned, entries: [...entries].reverse(), variables: { "current-period": "night" } }, { scene: "opening" }), "one-night");
  assert.equal(resolve(pruned, { scene: "garden" }), "global-garden");
  assert.equal(resolve({ ...pruned, variables: { "current-scene": "garden" } }), "global-garden", "an explicit scene variable takes precedence over opening art and defaults");
  assert.equal(resolve({ ...pruned, messages: [{ role: "assistant", stateSnapshot: { activeGreetingId: "unassigned" } }] }), "global-default", "an opening without assigned art falls back to Global");
  assert.equal(resolve(pruned, { scene: "unmapped" }), "one-default");
  assert.equal(resolve({ ...pruned, messages: [{ role: "assistant", stateSnapshot: { activeGreetingId: "unassigned" } }] }, { scene: "opening" }), "global-opening");
  assert.equal(resolve({ ...api, hasEarlierMessages: true }, { scene: "unmapped" }), "global-default");
  assert.equal(resolve({ ...api, entries: [{ id: "blank", role: "greeting", enabled: true, content: "" }], messages: [{ role: "assistant", content: "Legacy preview", activeSwipeIndex: 0, stateSnapshot: { activeGreetingId: null } }] }, { scene: "unmapped" }), "global-default");
});

test("sprite character suggestions include tagged imported characters alongside character-role entries", () => {
  const imported = ["Sera (Seraphine)", "Ryu (Ryutharax)", "Lilith (Vexthorne)", "Cinder (Black Wolf)", "Lupe (Grey Wolf)", "Maeve", "Athena"];
  const explicit = ["Urabel", "Diane (Bluerose)", "Kei"];
  const entries = [
    ...imported.map(name => ({ name, role: "custom" as const, tags: ["Characters"] })),
    ...explicit.map(name => ({ name, role: "character" as const, tags: ["Characters"] })),
    { name: "World Setting", role: "plot" as const, tags: ["Plot"] },
    { name: "Fiction Mode", role: "system" as const, tags: ["Preset"] },
    { name: "NPC: Urabel", role: "custom" as const, tags: [" character "] },
  ];
  const before = structuredClone(entries);
  assert.deepEqual(vnCharacterNames(entries), [...imported, ...explicit]);
  assert.deepEqual(entries, before);
});

test("asset assignment preserves existing expressions and all custom code outside the literal map", () => {
  const map = assignVnAsset(readVnAssetMap(spriteSource, "sprites"), "miveth", "happy", "@asset:new");
  const updated = writeVnAssetMap(spriteSource, "sprites", map);
  assert.deepEqual(readVnAssetMap(updated, "sprites"), { Miveth: { normal: "@asset:old", happy: "@asset:new" } });
  assert.ok(updated.startsWith('// Custom comment\nexport const sprites = '));
  assert.ok(updated.endsWith(';\nexport function spriteFor() { return sprites; }\n'));
  assert.deepEqual(readVnAssetMap(spriteSource, "sprites"), { Miveth: { normal: "@asset:old" } });
});

test("NPC pools add and remove separate cutouts without changing character assignments or source code", () => {
  const source = spriteSource + 'export const npcSprites = { male: { clerk: "@asset:clerk" }, female: {} };\nexport function npcSpriteFor() { return npcSprites; }\n';
  const pools = readVnNpcSpritePools(source);
  const assigned = assignVnNpcSprite(pools, "female", "merchant", "@asset:merchant");
  const updated = writeVnNpcSpritePools(source, assigned);
  assert.deepEqual(readVnNpcSpritePools(updated), { male: { clerk: "@asset:clerk" }, female: { merchant: "@asset:merchant" } });
  assert.deepEqual(readVnAssetMap(updated, "sprites"), readVnAssetMap(source, "sprites"));
  assert.ok(updated.startsWith(spriteSource));
  assert.ok(updated.endsWith('export function npcSpriteFor() { return npcSprites; }\n'));
  assert.deepEqual(removeVnNpcSprite(assigned, "female", "merchant"), pools);
  assert.deepEqual(readVnNpcSpritePools(spriteSource), { male: {}, female: {} });
  assert.ok(writeVnNpcSpritePools(spriteSource, assigned).startsWith(spriteSource));
});

test("NPC pool settings never evaluate or overwrite executable custom code", () => {
  for (const initializer of ['loadSprites()', '{ ...shared }', '{ male: fetch("/secret") }', '{ male: "@asset:portrait" }', '{ neutral: {} }', '{ male: { clerk: { normal: "@asset:a" } } }']) {
    const source = `export const npcSprites = ${initializer};`;
    assert.throws(() => readVnNpcSpritePools(source));
    assert.throws(() => writeVnNpcSpritePools(source, { male: {}, female: {} }));
  }
});

test("default choice and disabling defaults preserve uploaded pools, both default sets and authored code", () => {
  const source = spriteSource + '\nexport const npcSprites = { male: { custom: "@asset:custom" }, female: {} };\nexport const npcDefaults = { "disabled": false, "mode": "a" };\nexport const npcDefaultSpritesA = { male: { figure: "@asset:gray" }, female: {} };\nexport const npcDefaultSpritesB = { male: { guard: "@asset:guard" }, female: {} };\n';
  const switched = writeVnNpcDefaults(source, { disabled: false, mode: "b" });
  const disabled = writeVnNpcDefaults(switched, { disabled: true, mode: "b" });
  const reenabled = writeVnNpcDefaults(disabled, { disabled: false, mode: "b" });
  assert.deepEqual(readVnNpcDefaults(disabled), { disabled: true, mode: "b" });
  assert.deepEqual(readVnNpcDefaults(reenabled), { disabled: false, mode: "b" });
  for (const changed of [switched, disabled, reenabled]) {
    assert.deepEqual(readVnNpcSpritePools(changed), readVnNpcSpritePools(source));
    assert.deepEqual(readVnNpcDefaultSpritePools(changed, "a"), readVnNpcDefaultSpritePools(source, "a"));
    assert.deepEqual(readVnNpcDefaultSpritePools(changed, "b"), readVnNpcDefaultSpritePools(source, "b"));
    assert.deepEqual(readVnAssetMap(changed, "sprites"), readVnAssetMap(source, "sprites"));
    assert.ok(changed.startsWith(spriteSource));
  }
  assert.deepEqual(readVnNpcDefaults(spriteSource), { disabled: false, mode: "b" });
});

test("default settings reject executable, duplicate or malformed configurations without evaluating them", () => {
  for (const initializer of ['loadDefaults()', '{ "disabled": fetch("/secret"), "mode": "a" }', '{ "disabled": "false", "mode": "a" }', '{ "disabled": false, "mode": "c" }', '{ "disabled": false, "mode": "a", "extra": true }', '{ "mode": "a" }', '{ ...shared }', '{} as const']) {
    const source = `export const npcDefaults = ${initializer};`;
    assert.throws(() => readVnNpcDefaults(source));
    assert.throws(() => writeVnNpcDefaults(source, { disabled: true, mode: "b" }));
  }
  assert.throws(() => readVnNpcDefaults('export const npcDefaults = { "disabled": false, "mode": "a" };\nexport const npcDefaults = { "disabled": true, "mode": "b" };'));
});

test("literal maps accept quoted names, comments, single quotes and trailing commas without evaluating code", () => {
  const source = `export const sprites = { // cast\n 'Miveth': { normal: '@asset:a', happy: "@asset:b", }, "Evelia": '@asset:c', };`;
  assert.deepEqual(readVnAssetMap(source, "sprites"), { Miveth: { normal: "@asset:a", happy: "@asset:b" }, Evelia: "@asset:c" });
  for (const initializer of ['loadSprites()', '{ ...shared }', '{ [name]: "@asset:a" }', '{ Miveth: fetch("/secret") }', '{ Miveth: `@asset:a` }', '{} as const']) {
    const unsafe = `export const sprites = ${initializer};`;
    assert.throws(() => readVnAssetMap(unsafe, "sprites"));
    assert.throws(() => writeVnAssetMap(unsafe, "sprites", { Miveth: "@asset:new" }));
  }
});

test("removing an expression retains other assignments and removes an empty character slot", () => {
  const map = { Miveth: { normal: "@asset:a", happy: "@asset:b" }, Evelia: "@asset:c" };
  assert.deepEqual(removeVnAsset(map, "Miveth", "happy"), { Miveth: { normal: "@asset:a" }, Evelia: "@asset:c" });
  assert.deepEqual(removeVnAsset(map, "Evelia", "normal"), { Miveth: { normal: "@asset:a", happy: "@asset:b" } });
  assert.equal(vnAssetRows(map, "sprites").length, 3);
  assert.deepEqual(map, { Miveth: { normal: "@asset:a", happy: "@asset:b" }, Evelia: "@asset:c" });
});

test("backgrounds keep scene variants and upgrade the canonical old function to support a default", () => {
  const scenes = assignVnAsset({}, "hall", "day", "@asset:hall");
  scenes.default = "@asset:default";
  const updated = writeVnAssetMap(sceneSource, "backgrounds", scenes);
  const parsed = readVnAssetMap(updated, "backgrounds");
  assert.deepEqual(parsed, { hall: { day: "@asset:hall" }, default: "@asset:default" });
  assert.deepEqual(vnAssetRows(parsed, "backgrounds"), [{ name: "hall", variant: "day", assetRef: "@asset:hall" }]);
  const backgroundFor = new Function("scenes", updated.slice(updated.indexOf("export function backgroundFor")).replace("export ", "") + "; return backgroundFor;")(parsed);
  assert.equal(backgroundFor({ variables: {} }, {}), "@asset:default");
  assert.equal(backgroundFor({ variables: { "scene-bg": "@asset:legacy" } }, {}), "@asset:default");
  assert.equal(backgroundFor({ variables: {} }, { scene: "hall" }), "@asset:hall");
  const incomplete = { ...parsed, cellar: { night: "@asset:cellar" } };
  const incompleteBackgroundFor = new Function("scenes", updated.slice(updated.indexOf("export function backgroundFor")).replace("export ", "") + "; return backgroundFor;")(incomplete);
  assert.equal(incompleteBackgroundFor({ variables: { "current-period": "day" } }, { scene: "cellar" }), "@asset:default");
});

test("VN upload navigation recognizes saved custom VN copies and excludes Classic or unrelated custom UIs", () => {
  const root = { id: "root", name: "Custom name", entryFile: "index.tsx", updatedAt: "old", files: { "index.tsx": 'export default function UI(){ return <main className="vn" />; }', "sprites.ts": spriteSource, "scenes.ts": sceneSource } } as RootComponent;
  assert.equal(isVnInterface({ ...root, interfaceId: "custom:saved" }), true);
  assert.equal(isVnInterface({ ...root, interfaceId: "vn" }), true);
  assert.equal(isVnInterface({ ...root, interfaceId: "classic" }), false);
  assert.equal(isVnInterface({ ...root, files: { "index.tsx": "return <Chat />;" } }), false);
});
