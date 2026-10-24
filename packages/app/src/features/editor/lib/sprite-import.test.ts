import assert from "node:assert/strict";
import test from "node:test";
import { runSpriteImport, spriteImportProblems, spriteTargetIsCurrent, suggestSpriteEmotion, spriteImageFile, type SpriteImportItem } from "./sprite-import";
const item = (id: string, emotion = id): SpriteImportItem => ({ id, file: { name: `${id}.png`, type: "image/png" } as File, emotion, replace: false, status: "queued", progress: 0 });
test("filename suggestions require one whole configured expression", () => {
  const emotions = { happy: "Happy", sad: "Sad", battle_ready: "Battle Ready" };
  assert.equal(suggestSpriteEmotion("Kei-Battle_Ready.png", emotions), "battle_ready");
  assert.equal(suggestSpriteEmotion("unhappy.png", emotions), "");
  assert.equal(suggestSpriteEmotion("sad happy.png", emotions), "");
});
test("review blocks unknown expressions, duplicate slots, replacements and nonimages", () => {
  const rows = [item("a", "sad"), item("b", "sad"), item("c", "happy"), item("d", "missing"), { ...item("e"), file: { name: "e.svg", type: "image/svg+xml" } as File }];
  assert.deepEqual(spriteImportProblems(rows, { sad: "Sad", happy: "Happy" }, new Set(["happy"])), { a: "duplicate", b: "duplicate", c: "replace", d: "emotion", e: "image" });
  rows[2].replace = true;
  assert.equal(spriteImportProblems(rows, { sad: "Sad", happy: "Happy" }, new Set(["happy"])).c, undefined);
});
test("snapshot rejects source, card, interface and read-only changes", () => {
  const snapshot = { draftId: "card", rootId: "root", interfaceId: "vn", source: "source", character: "Kei", spriteType: "normal" };
  assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot }, false), true);
  for (const key of ["draftId", "rootId", "interfaceId", "source"] as const) assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot, [key]: "changed" }, false), false);
  assert.equal(spriteTargetIsCurrent(snapshot, snapshot, true), false);
});
test("snapshot rejects account and saved-world changes during uploads", () => {
  const snapshot = { draftId: "card", rootId: "root", interfaceId: "vn", source: "source", character: "Kei", spriteType: "normal", ownerId: "alice", serverWorldId: "saved-world" };
  assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot }, false), true);
  assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot, ownerId: "bob" }, false), false);
  assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot, serverWorldId: "other-world" }, false), false);
});
test("partial failures keep successful assignments and retry registered assets without uploading again", async () => {
  const rows = [item("happy"), item("sad"), item("normal")];
  const uploads: string[] = [], assigned: string[] = [];
  const actions = {
    isCurrent: () => true,
    upload: async (row: SpriteImportItem) => { uploads.push(row.id); return `@asset:${row.id}`; },
    assign: (row: SpriteImportItem) => { if (row.id === "sad") throw Error("conflict"); assigned.push(row.id); },
    update: (id: string, patch: Partial<SpriteImportItem>) => Object.assign(rows.find(row => row.id === id)!, patch),
    staleMessage: "stale",
  };
  await runSpriteImport(rows, actions);
  assert.deepEqual(assigned, ["happy", "normal"]);
  assert.equal(rows[1].assetRef, "@asset:sad");
  await runSpriteImport(rows, { ...actions, assign: row => { assigned.push(row.id); } });
  assert.deepEqual(uploads, ["happy", "sad", "normal"]);
  assert.deepEqual(assigned, ["happy", "normal", "sad"]);
});
test("source changes during upload stop assignments and later uploads", async () => {
  const rows = [item("happy"), item("sad")];
  let current = true, assigned = 0, uploads = 0;
  await runSpriteImport(rows, { isCurrent: () => current, upload: async () => { uploads++; current = false; return "@asset:kept"; }, assign: () => { assigned++; }, update: (id, patch) => Object.assign(rows.find(row => row.id === id)!, patch), staleMessage: "stale" });
  assert.equal(assigned, 0);
  assert.equal(uploads, 1);
  assert.equal(rows[0].assetRef, "@asset:kept");
});

test("batch review rejects AVIF because the asset endpoint does not accept it", () => { assert.equal(spriteImageFile({name:"happy.avif",type:"image/avif"}), false); });

test("snapshot isolates optional outfit variants and treats omitted variant as the base", () => {
  const snapshot = { draftId: "card", rootId: "root", interfaceId: "vn", source: "source", character: "Kei", spriteType: "work" };
  assert.equal(spriteTargetIsCurrent(snapshot, { ...snapshot, spriteVariant: "" }, false), true);
  const variant = { ...snapshot, spriteVariant: "raincoat" };
  assert.equal(spriteTargetIsCurrent(variant, { ...variant }, false), true);
  assert.equal(spriteTargetIsCurrent(variant, { ...variant, spriteVariant: "summer" }, false), false);
  assert.equal(spriteTargetIsCurrent(variant, { ...snapshot }, false), false);
});

test("variant changes during upload retain the asset but stop assignment and later uploads", async () => {
  const rows = [item("happy"), item("sad")];
  const target = { draftId: "card", rootId: "root", interfaceId: "vn", source: "source", character: "Kei", spriteType: "work", spriteVariant: "raincoat" };
  let variant = "raincoat", uploads = 0, assignments = 0;
  await runSpriteImport(rows, {
    isCurrent: () => spriteTargetIsCurrent(target, { ...target, spriteVariant: variant }, false),
    upload: async () => { uploads++; variant = "summer"; return "@asset:retained"; },
    assign: () => { assignments++; },
    update: (id, patch) => Object.assign(rows.find(row => row.id === id)!, patch),
    staleMessage: "variant changed",
  });
  assert.equal(uploads, 1);
  assert.equal(assignments, 0);
  assert.equal(rows[0].assetRef, "@asset:retained");
  assert.equal(rows[0].status, "error");
});
