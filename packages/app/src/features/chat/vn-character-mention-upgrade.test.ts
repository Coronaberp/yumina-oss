import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnCharacterMentionFiles } from "./vn-character-mention-upgrade";

const viewer = readFileSync(new URL("../../../../../interfaces/vn/character-viewer.tsx", import.meta.url), "utf8");
const legacyCopy = readFileSync(new URL("./test-fixtures/vn-character-copy-legacy.txt", import.meta.url), "utf8").trimEnd();
const legacyViewer = viewer.replace(/export function CharacterCopy\([\s\S]*?\n\}(?=\n\nfunction visibleText\()/, legacyCopy);

test("saved stock VN prose linkers upgrade without modifying other authored interface code", () => {
  const authored = '\nexport const creatorNote = "Keep this custom viewer styling";\n';
  const files = {
    "index.tsx": "Composed creator root",
    "character-viewer.tsx": legacyViewer + authored,
    "speaker-tag.ts": "Creator speaker matching",
    "character-showcase.ts": "Creator showcase",
    "status-config.ts": "Creator stats",
  };
  const upgraded = upgradeVnCharacterMentionFiles(files, viewer);
  assert.notEqual(upgraded, files);
  assert.equal(upgraded["character-viewer.tsx"], viewer + authored);
  for (const name of ["index.tsx", "speaker-tag.ts", "character-showcase.ts", "status-config.ts"] as const) assert.equal(upgraded[name], files[name]);
  assert.equal(files["character-viewer.tsx"], legacyViewer + authored);
  assert.equal(upgradeVnCharacterMentionFiles(upgraded, viewer), upgraded);
});

test("nested saved VN viewers are upgraded alongside their original modules", () => {
  const files = { "ui/character-viewer.tsx": legacyViewer, "ui/styles.ts": "Creator CSS" };
  const upgraded = upgradeVnCharacterMentionFiles(files, viewer);
  assert.equal(upgraded["ui/character-viewer.tsx"], viewer);
  assert.equal(upgraded["ui/styles.ts"], files["ui/styles.ts"]);
  assert.equal(Object.hasOwn(upgraded, "character-viewer.tsx"), false);
});

test("custom mention handlers, unrelated files and invalid templates are left intact", () => {
  const cases: Record<string, string>[] = [
    { "character-viewer.tsx": legacyViewer.replace('button.className = "vn-character-link"', 'button.className = "creator-character-link"') },
    { "custom-viewer.tsx": legacyViewer },
    { "character-viewer.tsx": viewer },
  ];
  for (const files of cases) assert.equal(upgradeVnCharacterMentionFiles(files, viewer), files);
  const saved = { "character-viewer.tsx": legacyViewer };
  assert.equal(upgradeVnCharacterMentionFiles(saved, "Unrelated template"), saved);
});
