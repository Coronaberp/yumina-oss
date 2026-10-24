import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { upgradeVnCheckpointFiles } from './vn-checkpoint-upgrade';
import { upgradeVnModelRoutingFiles } from './vn-model-routing-upgrade';
import { beforeModelRouting } from './test-fixtures/vn-reader-before-polish';
const source = new URL('../../../../../interfaces/vn/', import.meta.url);
// Model details were introduced after the stock checkpoint migration.
const currentRoot = beforeModelRouting(readFileSync(new URL('index.tsx', source), 'utf8'));
const checkpoints = readFileSync(new URL('checkpoints.tsx', source), 'utf8');
const legacy = readFileSync(new URL('./test-fixtures/vn-checkpoints-legacy.txt', import.meta.url), 'utf8');
const oldRoot = currentRoot
  .replace('busy, run, onRestore })', 'busy, run })')
  .replace('  const cursorRevision = React.useRef(0);\n', '')
  .replace('    const revision = cursorRevision.current;\n', '')
  .replace('if (revision === cursorRevision.current && value && typeof value.turn', 'if (value && typeof value.turn')
  .replace('await api.restoreCheckpoint(checkpoint.id); onRestore(); onClose();', 'await api.restoreCheckpoint(checkpoint.id); onClose();')
  .replace('            <p>Loading returns to the first page of the saved reply.</p>\n', '')
  .replace(' run={run} onRestore={() => { cursorRevision.current++; setCursor({ turn: "", index: 0 }); setPendingPlayerSprite(null); playerSpriteRequest.current = null; setAuto(false); }} />', ' run={run} />');

test('saved stock checkpoint modules and readers receive the canonical acknowledgment and restore behavior', () => {
  const files = { 'index.tsx': oldRoot, 'checkpoints.tsx': legacy, 'sprites.ts': 'authored art', 'styles.ts': 'authored styles' };
  const next = upgradeVnCheckpointFiles(files, checkpoints);
  assert.notEqual(next, files);
  assert.equal(next['index.tsx'], currentRoot); assert.equal(next['checkpoints.tsx'], checkpoints);
  assert.equal(next['sprites.ts'], files['sprites.ts']); assert.equal(next['styles.ts'], files['styles.ts']);
  assert.equal(files['index.tsx'], oldRoot); assert.equal(files['checkpoints.tsx'], legacy);
  assert.equal(upgradeVnCheckpointFiles(next, checkpoints), next);
});
test('nested and multiple saved stock readers preserve their own paths', () => {
  const files = { 'ui/story.tsx': oldRoot, 'ui/other.tsx': oldRoot, 'ui/checkpoints.tsx': legacy };
  const next = upgradeVnCheckpointFiles(files, checkpoints);
  assert.equal(next['ui/story.tsx'], currentRoot); assert.equal(next['ui/other.tsx'], currentRoot);
  assert.equal(next['ui/checkpoints.tsx'], checkpoints); assert.equal(next['checkpoints.tsx'], undefined);
});
test('model routing waits for stock checkpoint prerequisites without blocking restore compatibility', () => {
  const modelRouting = readFileSync(new URL('model-routing-details.tsx', source), 'utf8');
  const files = { 'index.tsx': oldRoot, 'checkpoints.tsx': legacy };
  assert.equal(upgradeVnModelRoutingFiles(files, modelRouting), files, 'the old Menu cannot receive currentMessage before onRestore');
  const restored = upgradeVnCheckpointFiles(files, checkpoints);
  assert.equal(restored['index.tsx'], currentRoot, 'checkpoint cursor revision and restore callback are installed first');
  const routed = upgradeVnModelRoutingFiles(restored, modelRouting);
  assert.equal(beforeModelRouting(routed['index.tsx']), currentRoot, 'later model details preserve every checkpoint byte');
  assert.equal(upgradeVnCheckpointFiles(routed, checkpoints), routed);
  const customMenu = oldRoot.replace('function Menu({ api, onClose', 'function Menu({ api, currentMessage, onClose');
  const custom = { 'index.tsx': customMenu, 'checkpoints.tsx': checkpoints };
  assert.equal(upgradeVnCheckpointFiles(custom, checkpoints), custom, 'unknown mixed Menu signatures remain author-owned');
});
test('authored checkpoint modules and customized restore handlers remain unchanged', () => {
  const customModule = '// Creator save integration\n' + legacy;
  const customRoot = oldRoot.replace('await api.restoreCheckpoint(checkpoint.id); onClose();', 'await customRestore(checkpoint.id); onClose();');
  const files = { 'index.tsx': customRoot, 'checkpoints.tsx': customModule };
  assert.equal(upgradeVnCheckpointFiles(files, checkpoints), files);
});
test('partially customized hooks and missing canonical helper input are declined', () => {
  const partial = oldRoot.replace('busy, run })', 'busy, run, onRestore })');
  const files = { 'index.tsx': partial, 'checkpoints.tsx': checkpoints };
  assert.equal(upgradeVnCheckpointFiles(files, checkpoints), files);
  assert.equal(upgradeVnCheckpointFiles({ 'index.tsx': oldRoot, 'checkpoints.tsx': legacy }, 'custom helper')['index.tsx'], oldRoot);
});

test('older readers without pending-player state use a cursor-only reset', () => {
  const older = oldRoot.replaceAll('setPendingPlayerSprite', 'setCustomPendingSprite').replaceAll('playerSpriteRequest', 'customSpriteRequest');
  const next = upgradeVnCheckpointFiles({ 'index.tsx': older, 'checkpoints.tsx': checkpoints }, checkpoints);
  assert.notEqual(next['index.tsx'], older);
  assert.match(next['index.tsx'], /onRestore=\{\(\) => \{ cursorRevision.current\+\+; setCursor\(\{ turn: "", index: 0 \}\); setAuto\(false\); \}\}/);
  assert.doesNotMatch(next['index.tsx'], /setPendingPlayerSprite|playerSpriteRequest/);
});
test('partly customized pending-player declarations cannot receive undefined reset identifiers', () => {
  const custom = oldRoot.replace('const playerSpriteRequest = React.useRef(null);', 'const playerSpriteRequest = customRequest();');
  const files = { 'index.tsx': custom, 'checkpoints.tsx': checkpoints };
  assert.equal(upgradeVnCheckpointFiles(files, checkpoints), files);
});
