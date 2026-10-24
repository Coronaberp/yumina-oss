import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import React, { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { bundleAndCompile } from '../studio/lib/tsx-bundler';
import { upgradeVnCheckpointFiles } from './vn-checkpoint-upgrade';
import { beforeModelRouting } from './test-fixtures/vn-reader-before-polish';

const source = new URL('../../../../../interfaces/vn/', import.meta.url);
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(new URL(name, source), 'utf8')]));
const legacyRoot = beforeModelRouting(files['index.tsx']!)
  .replace('busy, run, onRestore })', 'busy, run })')
  .replace('  const cursorRevision = React.useRef(0);\n', '')
  .replace('    const revision = cursorRevision.current;\n', '')
  .replace('if (revision === cursorRevision.current && value && typeof value.turn', 'if (value && typeof value.turn')
  .replace('await api.restoreCheckpoint(checkpoint.id); onRestore(); onClose();', 'await api.restoreCheckpoint(checkpoint.id); onClose();')
  .replace('            <p>Loading returns to the first page of the saved reply.</p>\n', '')
  .replace(' run={run} onRestore={() => { cursorRevision.current++; setCursor({ turn: "", index: 0 }); setPendingPlayerSprite(null); playerSpriteRequest.current = null; setAuto(false); }} />', ' run={run} />');
const legacyCheckpoints = readFileSync(new URL('./test-fixtures/vn-checkpoints-legacy.txt', import.meta.url), 'utf8');
async function stage(deferCursor = false, savedCard = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  const snapshot = [{ id: 'saved-reply', role: 'assistant', content: '*First passage.*\n\n*Second passage.*\n\n*Final passage.*', activeSwipeIndex: 0 }];
  const preferences = JSON.stringify({ textSize: 32, autoDelay: 7000, showTokenStatistics: false });
  const memory = new Map([['vn:settings', preferences], ['unrelated-preference', 'retained']]);
  const notices: unknown[][] = [];
  let resolveCursor!: (value: string | null) => void;
  const cursorRead = new Promise<string | null>(resolve => { resolveCursor = resolve; });
  let failSave = false, failRestore = false;
  let saveCompletion: Promise<void> | undefined;
  const api = {
    sessionId: 'restore-fixture', variables: { scene: 'courtyard' }, entries: [], messages: structuredClone(snapshot),
    pendingChoices: [], isStreaming: false, readOnly: false,
    checkpoints: [{ id: 'saved', name: 'Before the duel', messageCount: 1, createdAt: '2026-10-22T00:00:00Z' }],
    storage: { get: async (key: string) => deferCursor && key === "vn:restore-fixture:cursor" ? cursorRead : memory.get(key) ?? null, set: async (key: string, value: string) => { memory.set(key, value); } },
    renderMarkdown: (text: string) => text, resolveAssetUrl: (ref: string) => ref,
    loadCheckpoints: async () => api.checkpoints,
    saveCheckpoint: async () => { if (failSave) throw new Error('Save failed'); await saveCompletion; },
    showToast: (...args: unknown[]) => notices.push(args),
    restoreCheckpoint: async () => { if (failRestore) throw new Error('Restore failed'); api.messages = structuredClone(snapshot); },
  };
  const activeFiles = savedCard ? upgradeVnCheckpointFiles({ ...files, 'index.tsx': legacyRoot, 'checkpoints.tsx': legacyCheckpoints }, files['checkpoints.tsx']!) : files;
  const result = bundleAndCompile({ files: activeFiles, entryFile: 'index.tsx' }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
    assert.ok(button, `Missing button: ${label}`); await act(async () => button.click());
  };
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  await render();
  return { api, snapshot, memory, notices, preferences, container, click, render,
    holdSave: () => { let resolve!: () => void; saveCompletion = new Promise<void>(done => { resolve = done; }); return resolve; },
    finishHydration: async (value: string) => { await act(async () => resolveCursor(value)); },
    page: () => container.querySelector('.vn-progress')!.textContent!,
    failSave: (value: boolean) => { failSave = value; }, failRestore: (value: boolean) => { failRestore = value; },
    close: async () => {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test('checkpoint saving acknowledges success once and never announces a failed save', async () => {
  const h = await stage();
  try {
    await h.click('Menu'); await h.click('Save');
    h.failSave(true); await h.click('Save');
    assert.deepEqual(h.notices, []); assert.match(h.container.querySelector('[role="alert"]')!.textContent!, /Save failed/);
    h.failSave(false); await h.click('Save');
    assert.deepEqual(h.notices, [['Checkpoint saved', 'success']]);
    assert.equal(h.container.querySelector('.vn-save'), null);
  } finally { await h.close(); }
});

test('restoring the same reply consistently opens page one without changing scene or preferences', async () => {
  const h = await stage();
  try {
    await h.click('Advance story'); await h.click('Advance story'); assert.match(h.page(), /Page 3 of 3/);
    await h.click('Menu'); await h.click('Load'); await h.click('Before the duel');
    assert.match(h.page(), /Page 1 of 3/, 'same reply/swipe must reset just like changed latest turns');
    assert.equal(h.memory.get('vn:settings'), h.preferences); assert.equal(h.memory.get('unrelated-preference'), 'retained');
    assert.deepEqual(h.api.messages, h.snapshot); assert.deepEqual(h.api.variables, { scene: 'courtyard' });
    assert.equal(JSON.parse(h.memory.get('vn:restore-fixture:cursor')!).index, 0);
  } finally { await h.close(); }
});

test('load explains first-page semantics and failed restoration preserves the reading cursor', async () => {
  const h = await stage();
  try {
    await h.click('Advance story'); h.failRestore(true);
    await h.click('Menu'); await h.click('Load');
    assert.match(h.container.textContent!, /Loading returns to the first page of the saved reply/);
    await h.click('Before the duel');
    assert.match(h.page(), /Page 2 of 3/);
    assert.ok(h.container.querySelector('[aria-label="Story menu"]'));
    assert.equal(h.memory.get('vn:settings'), h.preferences);
  } finally { await h.close(); }
});

for (const savedCard of [false, true]) test(`${savedCard ? 'upgraded legacy' : 'canonical'} pending cursor read cannot undo restore while settings hydrate`, async () => {
  const h = await stage(true, savedCard);
  try {
    await h.click('Menu'); await h.click('Load'); await h.click('Before the duel');
    assert.match(h.page(), /Page 1 of 3/);
    await h.finishHydration(JSON.stringify({ turn: 'saved-reply:0', index: 2 }));
    assert.match(h.page(), /Page 1 of 3/, 'late pre-restore cursor hydration must be ignored');
    assert.equal((h.container.querySelector('.vn') as HTMLElement).style.getPropertyValue('--text-size'), '32px');
    assert.equal(h.memory.get('vn:settings'), h.preferences);
    assert.equal(h.memory.get('unrelated-preference'), 'retained');
  } finally { await h.close(); }
});

test('a late save from a replaced session cannot acknowledge or close the new save dialog', async () => {
  const h = await stage();
  try {
    await h.click('Menu'); await h.click('Save');
    const finishSave = h.holdSave(); await h.click('Save');
    h.api.sessionId = 'other-session'; await h.render();
    assert.ok(h.container.querySelector('.vn-save'));
    await act(async () => finishSave());
    assert.deepEqual(h.notices, []);
    assert.ok(h.container.querySelector('.vn-save'), 'old completion cannot close the current session dialog');
  } finally { await h.close(); }
});
