import assert from "node:assert/strict";
import test from "node:test";
import { addVnSpriteOption, assignVnSprite, readVnSpriteSets, type WorldDefinition } from "@yumina/engine";
import { requestedTarget } from "./studio-image-references.js";
import { slotOperation, targetIsVerified } from "./studio-image-workflow.js";
import { applyVnAssetOperation } from "./studio-tools/vn-asset-tools.js";
import { getStructuralPreflight } from "./studio-tools/project-intelligence.js";

function world() {
  let source = 'export const sprites = { Alice: { normal: "@asset:normal" } };\n// preserve custom runtime';
  source = addVnSpriteOption(source, "types", "Battle Wear");
  source = addVnSpriteOption(source, "emotions", "Embarrassed");
  return { id: "test", version: "19.0.0", name: "test", entries: [{ id: "alice-id", name: "Alice", role: "character", enabled: true, content: "Mage" }], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
    rootComponent: { id: "root", name: "VN", interfaceId: "vn", entryFile: "index.tsx", files: { "index.tsx": "", "sprites.ts": source, "scenes.ts": "export const scenes = {};" } },
  } as unknown as WorldDefinition;
}
const target = { kind: "sprite", characterId: "alice-id", expression: "embarrassed", spriteType: "battle-wear" } as const;

test("image targets discover exact custom wardrobe and alias-like emotion labels", () => {
  const current = world();
  assert.deepEqual(requestedTarget(current, "", "Draw Alice's Embarrassed sprite in Battle Wear", {}).target, target);
  assert.deepEqual(requestedTarget(current, "", "", target).target, target);
  assert.equal(requestedTarget(current, "", "Draw Alice happy sprite", {}).target!.spriteType, "normal");
});

test("unknown catalog IDs leave generated art unassigned", () => {
  const current = world();
  assert.match(requestedTarget(current, "", "", { ...target, spriteType: "missing" }).reason!, /spriteConfig/);
  assert.match(requestedTarget(current, "", "", { ...target, expression: "missing" }).reason!, /spriteConfig/);
  assert.match(slotOperation(current, { ...target, spriteType: "missing" }, "@asset:new").reason!, /no longer configured/);
});

test("generated sprite assignment uses character display name and exact wardrobe slot", () => {
  const current = world();
  const operation = slotOperation(current, target, "@asset:battle").operation!;
  assert.equal(operation.name, "Alice");
  assert.equal(operation.spriteType, "battle-wear");
  applyVnAssetOperation(current, operation);
  const source = current.rootComponent!.files["sprites.ts"]!;
  assert.deepEqual(readVnSpriteSets(source).normal!.Alice, { normal: "@asset:normal" });
  assert.deepEqual(readVnSpriteSets(source)["battle-wear"]!.Alice, { embarrassed: "@asset:battle" });
  assert.equal(targetIsVerified(current, target, "@asset:battle"), true);
  assert.equal(targetIsVerified(current, { ...target, spriteType: "normal" }, "@asset:battle"), false);
  assert.equal(slotOperation(current, target, "@asset:battle").alreadyAssigned, true);
  assert.match(slotOperation(current, target, "@asset:replacement").reason!, /filled while/);
});

test("occupied Normal art does not block another wardrobe's matching emotion", () => {
  const current = world();
  current.rootComponent!.files["sprites.ts"] = assignVnSprite(current.rootComponent!.files["sprites.ts"]!, "Alice", "normal", "embarrassed", "@asset:old-emotion");
  assert.ok(slotOperation(current, target, "@asset:new").operation);
});

test("sprite preflight inventories assets in every wardrobe", () => {
  const current = world();
  applyVnAssetOperation(current, slotOperation(current, target, "@asset:battle").operation!);
  assert.match(JSON.stringify(getStructuralPreflight(current)), /@asset:battle/);
});

test("author-prefixed character names assign and verify the canonical VN map key", () => {
  const current = world();
  current.entries[0]!.name = "Character: Alice";
  assert.deepEqual(requestedTarget(current, "", "Draw Alice embarrassed in battle wear sprite", {}).target, target);
  const operation = slotOperation(current, target, "@asset:battle").operation!;
  assert.equal(operation.name, "Alice");
  applyVnAssetOperation(current, operation);
  assert.deepEqual(readVnSpriteSets(current.rootComponent!.files["sprites.ts"]!)["battle-wear"], { Alice: { embarrassed: "@asset:battle" } });
  assert.equal(targetIsVerified(current, target, "@asset:battle"), true);
  assert.equal(slotOperation(current, target, "@asset:battle").alreadyAssigned, true);
  assert.match(slotOperation(current, target, "@asset:replacement").reason!, /filled while/);
  assert.equal(slotOperation(current, { ...target, spriteType: "normal", expression: "normal" }, "@asset:normal").alreadyAssigned, true);
});

test("variant generation targets capture exact slot and never overwrite base artwork", () => {
  const current = world();
  current.rootComponent!.files["sprites.ts"] += '\nexport const spriteVariants = { "battle-wear": { rain: "Rain" } };';
  const variant = { ...target, spriteVariant: "rain" };
  assert.deepEqual(requestedTarget(current, "", "", variant).target, variant);
  assert.match(requestedTarget(current, "", "", { ...variant, spriteVariant: "missing" }).reason!, /variant/);
  const operation = slotOperation(current, variant, "@asset:rain").operation!;
  assert.equal(operation.spriteVariant, "rain");
  applyVnAssetOperation(current, operation);
  assert.equal(targetIsVerified(current, variant, "@asset:rain"), true);
  assert.equal(targetIsVerified(current, target, "@asset:rain"), false);
  assert.match(slotOperation(current, variant, "@asset:other").reason!, /filled/);
  assert.match(slotOperation(current, { ...variant, spriteVariant: "missing" }, "@asset:x").reason!, /variant/);
});
