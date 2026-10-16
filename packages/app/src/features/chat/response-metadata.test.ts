import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { stripGameStateDump, stripVariableUpdateTags } from "../../../../engine/src/parser/response-metadata";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradeVnMetadataFiles } from "./vn-metadata-upgrade";

test("saved VN metadata upgrades retain every other file and remain idempotent", () => {
  const current = readFileSync(new URL('../../../../../interfaces/vn/metadata.ts', import.meta.url), 'utf8');
  const old = current.replace(/  const stripped = literals\.text\n    \.replace\([^\n]+\)\n    \.replace\(/, '  const stripped = literals.text.replace(');
  assert.notEqual(old, current);
  const files = { 'index.tsx': 'className="vn-stage"', 'metadata.ts': old, 'sprites.ts': 'authored art' };
  const upgraded = upgradeVnMetadataFiles(files);
  assert.equal(upgraded['metadata.ts'], current);
  assert.equal(upgraded['sprites.ts'], files['sprites.ts']);
  assert.equal(upgradeVnMetadataFiles(upgraded), upgraded);
  const chat = { ...files, 'index.tsx': 'return <Chat />' };
  assert.equal(upgradeVnMetadataFiles(chat), chat);
});

test("state snapshot filtering preserves ordinary prose and accepts paired XML or bracket wrappers", () => {
  const prose = "The game-state is displayed in the menu.\n[health: -1]";
  assert.equal(stripGameStateDump(prose), prose);
  assert.equal(stripGameStateDump("Before\n<game-state>\na: 1\n</game-state>\nAfter"), "Before\n\nAfter");
  assert.equal(stripGameStateDump("Before\n[game-state]\na: 1\n[/game-state]\nAfter"), "Before\n\nAfter");
});

test("an unmatched state opener cannot swallow later narrative", () => {
  const content = "[game-state]\nacademy-day: 1\n*The clerk waits.*";
  assert.equal(stripGameStateDump(content), content);
});

test("variable-update headings are hidden in both bracket and XML forms without removing their contents", () => {
  const text = 'Before\n[Variable-updates]\n[energy: subtract 1]\n[/variable-updates]\nAfter';
  assert.equal(stripVariableUpdateTags(text), 'Before\n\n[energy: subtract 1]\n\nAfter');
  assert.equal(stripVariableUpdateTags('[variable-updates]\n*The clerk waits.*'), '\n*The clerk waits.*');
  assert.equal(stripVariableUpdateTags('```text\n[Variable-updates]\n```'), '```text\n[Variable-updates]\n```');
  assert.equal(stripVariableUpdateTags('The label is `[Variable-updates]`.'), 'The label is `[Variable-updates]`.');
});

test("saved VN replies never create a passage for a variable-update heading", () => {
  const text = '*Maeve waves.*\n\n[Variable-updates]\n<Yield>Choices follow</yield>\n<Yield></yield>\n<Yunmina-state version="1" status="updated" count="3" />\n[Yumina-state version="1" Status="Updated" Count="2"]';
  const source = new URL('../../../../../interfaces/vn/', import.meta.url);
  const files = Object.fromEntries(readdirSync(source).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, source), 'utf8')]));
  files['metadata-fixture.tsx'] = `import { passages } from "./passages"; export default function Fixture(){return passages([],${JSON.stringify(text)},${JSON.stringify(text)});}`;
  const bundled = bundleAndCompile({ files, entryFile: 'metadata-fixture.tsx' });
  assert.equal(bundled.error, null);
  const result = (bundled.Component as unknown as () => Array<{text: string}>)();
  assert.ok(result.length > 0);
  assert.ok(result.every(line => !line.text.includes('Variable-updates')));
  assert.ok(result.every(line => !/yield|choices follow|Yunmina|Yumina-state|[<>]/i.test(line.text)));
});
