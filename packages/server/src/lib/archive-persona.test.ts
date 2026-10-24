import assert from "node:assert/strict";
import test from "node:test";
import { archivePersonaSchema, archivePersonaProfileId, restoreArchivePersona } from "./archive-persona.js";
const source = { persona: { id: "owned", name: "Saved identity", backstory: "Saved continuity", sprites: { normal: "/cdn/saved-sprite" } }, started: true, selection: { kind: "player", id: "owned" }, selectionVersion: "source-token" };
const none = new Set<string>();
test("owned player binding survives without replacing the saved snapshot and gets a fresh destination version", () => {
  const parsed = archivePersonaSchema.parse(source);
  const restored = restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none });
  assert.deepEqual(restored.persona, source.persona); assert.deepEqual(restored.selection, source.selection);
  assert.equal(restored.started, true); assert.ok(restored.selectionVersion); assert.notEqual(restored.selectionVersion, source.selectionVersion);
  assert.notEqual(restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none }).selectionVersion, restored.selectionVersion);
});
test("account selection retains only its verified owned profile ID", () => {
  const parsed = archivePersonaSchema.parse({ ...source, selection: { kind: "account" } });
  const restored = restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none });
  assert.equal(restored.persona?.id, "owned"); assert.deepEqual(restored.selection, { kind: "account" });
});
test("creator preset selection is retained only in its validated destination card", () => {
  const parsed = archivePersonaSchema.parse({ ...source, persona: { ...source.persona, id: "creator" }, selection: { kind: "preset", id: "creator" } });
  assert.equal(archivePersonaProfileId(parsed), undefined);
  const restored = restoreArchivePersona(parsed, { presetIds: new Set(["creator"]) });
  assert.equal(restored.persona?.id, "creator"); assert.deepEqual(restored.selection, { kind: "preset", id: "creator" });
});
test("foreign or deleted profile links stay detached while their saved public identity is preserved", () => {
  const parsed = archivePersonaSchema.parse(source);
  const restored = restoreArchivePersona(parsed, { presetIds: none });
  assert.equal(restored.persona?.id, undefined); assert.equal(restored.selection, undefined);
  assert.equal(restored.persona?.name, source.persona.name); assert.equal(restored.persona?.backstory, source.persona.backstory);
  assert.deepEqual(restored.persona?.sprites, source.persona.sprites); assert.ok(restored.selectionVersion);
});
test("a missing creator preset cannot bind to an account profile with the same ID", () => {
  const parsed = archivePersonaSchema.parse({ ...source, selection: { kind: "preset", id: "owned" } });
  const restored = restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none });
  assert.equal(restored.persona?.id, undefined); assert.equal(restored.selection, undefined); assert.equal(restored.persona?.name, source.persona.name);
});
test("mismatched profile IDs do not guess which saved identity to link", () => {
  const parsed = archivePersonaSchema.parse({ ...source, selection: { kind: "player", id: "different" } });
  assert.equal(archivePersonaProfileId(parsed), undefined);
  const restored = restoreArchivePersona(parsed, { ownedProfileId: "different", presetIds: none });
  assert.equal(restored.persona?.id, undefined); assert.equal(restored.selection, undefined);
});
test("legacy saved profiles can retain an ownership-checked ID without following the current account default", () => {
  const parsed = archivePersonaSchema.parse({ persona: source.persona, started: false });
  assert.equal(archivePersonaProfileId(parsed), "owned");
  const restored = restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none });
  assert.equal(restored.persona?.id, "owned"); assert.deepEqual(restored.selection, { kind: "account" }); assert.equal(restored.started, false);
});
test("restoring a persona does not mutate the archive or accept private profile fields", () => {
  const parsed = archivePersonaSchema.parse({ ...source, persona: { ...source.persona, note: "PRIVATE", userId: "foreign" } });
  const before = JSON.stringify(parsed);
  restoreArchivePersona(parsed, { ownedProfileId: "owned", presetIds: none });
  assert.equal(JSON.stringify(parsed), before); assert.ok(!JSON.stringify(parsed).includes("PRIVATE"));
  assert.equal(archivePersonaSchema.safeParse({ ...source, selection: { kind: "none" } }).success, false);
});
