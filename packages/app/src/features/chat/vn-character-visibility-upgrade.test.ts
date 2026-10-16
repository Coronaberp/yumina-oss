import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { upgradeVnCharacterVisibilityFiles } from './vn-character-visibility-upgrade';

const read = (name: string) => readFileSync(new URL(`../../../../../interfaces/vn/${name}`, import.meta.url), 'utf8');
const helper = read('character-visibility.ts');
const signature = 'export function StatusSheet({ api, onClose, onBack, preview = false, filterCharacters })';
const layout = '<StatusLayout config={!preview && filterCharacters ? filterCharacters(statusConfig) : statusConfig}';
const filteredSheet = read('status-sheet.tsx');
const originalSheet = filteredSheet.replace(signature, signature.replace(', filterCharacters', '')).replace(layout, '<StatusLayout config={statusConfig}');
const originalRoot = read('index.tsx')
  .replace('import { useMetCharacters, visibleCharacterStatus } from "./character-visibility";\n', '')
  .replace('  const metCharacterIds = useMetCharacters(sceneApi, currentMessage, readLines, panel === "status");\n\n', '')
  .replace(' filterCharacters={config => visibleCharacterStatus(config, sceneApi.entries, metCharacterIds)}', '');

test('encounter upgrades preserve custom layouts, configs, art, widgets and tap handlers', () => {
  const customRoot = originalRoot.replace('    if (scrollPassage()) return;', '    if (customReader()) return;');
  const files = { 'index.tsx': customRoot, 'status-sheet.tsx': originalSheet,
    'status-layout.tsx': 'authored relationship layout', 'status-config.ts': 'authored pips and gauges', 'sprites.ts': 'authored sprites', 'social-standing.tsx': 'authored widgets' };
  const next = upgradeVnCharacterVisibilityFiles(files, helper);
  assert.notEqual(next, files);
  assert.match(next['index.tsx']!, /filterCharacters=/);
  assert.match(next['index.tsx']!, /if \(customReader\(\)\) return/);
  assert.equal(next['status-sheet.tsx'], filteredSheet);
  assert.equal(next['character-visibility.ts'], helper);
  for (const name of ['status-layout.tsx', 'status-config.ts', 'sprites.ts', 'social-standing.tsx']) assert.equal(next[name], files[name as keyof typeof files]);
  assert.equal(files['index.tsx'], customRoot);
  assert.equal(upgradeVnCharacterVisibilityFiles(next, helper), next);
});

test('already upgraded stock sheets and nested interfaces receive the parent hookup', () => {
  const files = { 'ui/index.tsx': originalRoot, 'ui/status-sheet.tsx': filteredSheet };
  const next = upgradeVnCharacterVisibilityFiles(files, helper);
  assert.match(next['ui/index.tsx']!, /useMetCharacters/);
  assert.equal(next['ui/status-sheet.tsx'], filteredSheet);
  assert.equal(next['ui/character-visibility.ts'], helper);
  assert.equal(next['character-visibility.ts'], undefined);
});

test('unrecognized sheet renderers, existing custom helpers and non-VNs are retained', () => {
  const cases: Record<string, string>[] = [
    { 'index.tsx': originalRoot, 'status-sheet.tsx': 'authored custom sheet' },
    { 'index.tsx': originalRoot, 'status-sheet.tsx': originalSheet, 'character-visibility.ts': 'authored custom visibility' },
    { 'index.tsx': 'export default function Chat() {}', 'status-sheet.tsx': originalSheet },
  ];
  for (const files of cases) assert.equal(upgradeVnCharacterVisibilityFiles(files, helper), files);
});
