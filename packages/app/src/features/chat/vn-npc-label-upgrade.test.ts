import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnNpcLabelFiles } from "./vn-npc-label-upgrade";

const source = readFileSync(new URL('../../../../../interfaces/vn/index.tsx', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../../../../../interfaces/vn/npc-display-name.ts', import.meta.url), 'utf8');
const legacy = source.replace('import { npcSpeakerLabels } from "./npc-display-name";\n', '')
  .replace('    const npcLabels = npcSpeakerLabels(api, message, sourceLines);\n', '')
  .replace('  const npcLabels = npcSpeakerLabels(sceneApi, currentMessage, lines);\n', '')
  .replace('npcLabels[sourceLines.indexOf(line)] || ', '')
  .replace('npcLabels[index] || ', '');

test('stock saved VN display hooks acquire earned NPC labels and preserve authored modules', () => {
  const files = { 'index.tsx': legacy, 'sprites.ts': 'Custom sprite art', 'status-config.ts': 'Custom stats', 'character-viewer.tsx': 'Custom viewer' };
  const updated = upgradeVnNpcLabelFiles(files, helper);
  assert.notEqual(updated, files);
  assert.equal(updated['index.tsx'], source);
  assert.equal(updated['npc-display-name.ts'], helper);
  assert.equal(updated['sprites.ts'], files['sprites.ts']);
  assert.equal(updated['status-config.ts'], files['status-config.ts']);
  assert.equal(updated['character-viewer.tsx'], files['character-viewer.tsx']);
  assert.equal(files['index.tsx'], legacy);
  assert.equal(upgradeVnNpcLabelFiles(updated, helper), updated);
});

test('nested stock VN roots receive the helper next to their authored sources', () => {
  const files = { 'ui/root.tsx': legacy, 'ui/styles.ts': 'Custom CSS' };
  const updated = upgradeVnNpcLabelFiles(files, helper);
  assert.equal(updated['ui/root.tsx'], source);
  assert.equal(updated['ui/npc-display-name.ts'], helper);
  assert.equal(updated['ui/styles.ts'], 'Custom CSS');
});

test('custom speaker displays, conflicting helpers and unrelated roots are skipped', () => {
  const cases: Record<string, string>[] = [
    { 'index.tsx': legacy.replace('name={line.name || "NPC"}', 'name={creatorLabel(line)}') },
    { 'index.tsx': legacy, 'npc-display-name.ts': 'Creator helper' },
    { 'index.tsx': 'Unrelated UI' },
    { 'index.tsx': source, 'npc-display-name.ts': helper },
  ];
  for (const files of cases) assert.equal(upgradeVnNpcLabelFiles(files, helper), files);
});

const previousHelper = readFileSync(new URL('./test-fixtures/vn-npc-display-name-legacy.txt', import.meta.url), 'utf8');

test('already-upgraded readers refresh only an exact previously shipped helper', () => {
  const nextHelper = helper + '\n// next stock revision\n';
  const files = { 'ui/root.tsx': source, 'ui/npc-display-name.ts': previousHelper, 'creator.ts': 'Authored content' };
  const updated = upgradeVnNpcLabelFiles(files, nextHelper);
  assert.notEqual(updated, files);
  assert.equal(updated['ui/npc-display-name.ts'], nextHelper);
  assert.equal(updated['ui/root.tsx'], source);
  assert.equal(updated['creator.ts'], files['creator.ts']);
  assert.equal(files['ui/npc-display-name.ts'], previousHelper);
  assert.equal(upgradeVnNpcLabelFiles(updated, nextHelper), updated);
});

test('helper refresh preserves customized helper code and unrelated same-name modules', () => {
  const nextHelper = helper + '\n// next stock revision\n';
  const cases: Record<string, string>[] = [
    { 'ui/root.tsx': source, 'ui/npc-display-name.ts': previousHelper + '\n// custom creator behavior\n' },
    { 'ui/root.tsx': source, 'ui/npc-display-name.ts': 'export function npcSpeakerLabels() { return creatorLabels; }' },
    { 'ui/root.tsx': source, 'my-npc-display-name.ts': previousHelper },
  ];
  for (const files of cases) assert.equal(upgradeVnNpcLabelFiles(files, nextHelper), files);
});

test('a legacy reader with the old stock helper updates helper and hooks in one pass', () => {
  const nextHelper = helper + '\n// next stock revision\n';
  const files = { 'index.tsx': legacy, 'npc-display-name.ts': previousHelper };
  const updated = upgradeVnNpcLabelFiles(files, nextHelper);
  assert.equal(updated['index.tsx'], source);
  assert.equal(updated['npc-display-name.ts'], nextHelper);
  assert.equal(upgradeVnNpcLabelFiles(updated, nextHelper), updated);
});
