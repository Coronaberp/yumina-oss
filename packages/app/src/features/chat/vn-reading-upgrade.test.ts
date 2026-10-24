import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnReadingFiles } from "./vn-reading-upgrade";

const source = readFileSync(new URL("../../../../../interfaces/vn/index.tsx", import.meta.url), "utf8");
const reading = readFileSync(new URL("../../../../../interfaces/vn/reading.ts", import.meta.url), "utf8");
const oldAdvance = `  function advance() {
    if (hidden) { setHidden(false); return; }
    movePage(1);
  }`;
const newAdvanceStart = source.indexOf("  const scrollPassage = usePassageReading(");
const newAdvanceEnd = source.indexOf("\n\n  function movePage(", newAdvanceStart);
const oldSource = (source.slice(0, newAdvanceStart) + oldAdvance + source.slice(newAdvanceEnd))
  .replace('import { usePassageReading } from "./reading";\n', "")
  // The supported pre-upgrade reader predates Auto's optional manual flag.
  // Reconstruct that fixture contract, not the current canonical implementation.
  .replace('function movePage(direction, manual = true)', 'function movePage(direction)')
  .replace('if (manual) setAuto(false);', 'setAuto(false);');

test("saved VN handlers acquire tap scrolling while authored files remain intact", () => {
  assert.ok(newAdvanceStart >= 0 && newAdvanceEnd > newAdvanceStart);
  assert.ok(oldSource.includes("function movePage(direction)"), "Fixture uses the supported legacy signature");
  const files = { "index.tsx": "Composed root", "__user-root.tsx": oldSource, "scenes.ts": "creator backgrounds", "status-layout.tsx": "creator status", "portrait.ts": "creator portrait" };
  const upgraded = upgradeVnReadingFiles(files, reading);
  assert.match(upgraded["__user-root.tsx"], /if \(scrollPassage\(\)\) return/);
  assert.equal(upgraded["reading.ts"], reading);
  for (const name of ["index.tsx", "scenes.ts", "status-layout.tsx", "portrait.ts"] as const) assert.equal(upgraded[name], files[name]);
  assert.equal(files["__user-root.tsx"], oldSource, "Do not mutate the card's source object");
  assert.equal(upgradeVnReadingFiles(upgraded, reading), upgraded);
});

test("current VN source and custom tap handlers are left alone", () => {
  const current = { "index.tsx": source, "reading.ts": reading };
  assert.equal(upgradeVnReadingFiles(current, reading), current);
  const custom = { "index.tsx": oldSource.replace("    movePage(1);", "    customAdvance();") };
  assert.equal(upgradeVnReadingFiles(custom, reading), custom);
  const newerSignature = { "index.tsx": oldSource.replace("function movePage(direction)", "function movePage(direction, manual = true)") };
  assert.equal(upgradeVnReadingFiles(newerSignature, reading), newerSignature, "A newer/custom signature is not rewritten as legacy");
  const customHelper = { "index.tsx": oldSource, "reading.ts": "Custom reader" };
  assert.equal(upgradeVnReadingFiles(customHelper, reading), customHelper);
});

test("nested saved interfaces resolve the reader alongside their own source", () => {
  const files = { "ui/story.tsx": oldSource };
  const upgraded = upgradeVnReadingFiles(files, reading);
  assert.equal(upgraded["ui/reading.ts"], reading);
  assert.equal(upgraded["reading.ts"], undefined);
});
