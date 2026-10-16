import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { observeSceneAssets } from '../../../sandbox/scene-asset-readiness';
import { resolveSandboxAssetUrl, setSandboxAssetLoader } from '../../../sandbox/asset-bridge';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  const started = Date.now();
  while (!check()) { assert.ok(Date.now() - started < 2000, 'Asset state did not settle'); await new Promise(done => setTimeout(done, 10)); }
}
function fixture() {
  const dom = new JSDOM('<main><img src="/image.png"></main>', { url: 'https://yumina.test/', pretendToBeVisual: true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousEvent = Object.getOwnPropertyDescriptor(globalThis, 'Event');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  const root = dom.window.document.querySelector('main')!, image = root.querySelector('img')!;
  const rect = { x: 0, y: 0, left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100, toJSON() {} };
  for (const node of [root, image]) {
    Object.defineProperty(node, 'getClientRects', { value: () => [rect] });
    Object.defineProperty(node, 'getBoundingClientRect', { value: () => rect });
  }
  let complete = false, width = 0;
  Object.defineProperties(image, { complete: { get: () => complete }, naturalWidth: { get: () => width } });
  const decode = deferred<void>(); Object.defineProperty(image, 'decode', { value: () => decode.promise });
  const states: { ready: boolean; error?: boolean }[] = [];
  let stop = () => {};
  return { dom, root, image, decode, states, start() { stop = observeSceneAssets(root, state => states.push(state)); },
    load() { complete = true; width = 100; image.dispatchEvent(new dom.window.Event('load')); },
    fail() { complete = true; width = 0; image.dispatchEvent(new dom.window.Event('error')); },
    reset() { complete = false; width = 0; },
    cleanup() { stop(); dom.window.close(); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); if (previousEvent) Object.defineProperty(globalThis, 'Event', previousEvent); },
  };
}

test('initial reveal waits for download, decode and fonts, then keeps later expression loads uncovered', async () => {
  const f = fixture(), fontsReady = deferred<void>();
  const fonts = Object.assign(new f.dom.window.EventTarget(), { status: 'loading', ready: fontsReady.promise });
  Object.defineProperty(f.dom.window.document, 'fonts', { value: fonts });
  try {
    f.start(); assert.equal(f.states.at(-1)?.ready, false); assert.equal(f.root.style.visibility, 'hidden');
    let actions = 0;
    f.dom.window.addEventListener('keydown', () => { ++actions; });
    f.image.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert.equal(actions, 0, 'Pending scenes cannot advance through keyboard shortcuts');
    f.load(); await new Promise(done => setTimeout(done, 40));
    assert.equal(f.states.at(-1)?.ready, false, 'Download alone does not complete decode or fonts');
    f.decode.resolve(); await new Promise(done => setTimeout(done, 40));
    assert.equal(f.states.at(-1)?.ready, false, 'Fonts still block reveal');
    fonts.status = 'loaded'; fontsReady.resolve();
    await until(() => f.states.at(-1)?.ready === true); assert.equal(f.root.style.visibility, '');
    f.image.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert.equal(actions, 1);
    f.reset(); f.image.src = '/next-expression.png';
    await new Promise(done => setTimeout(done, 80));
    assert.equal(f.states.at(-1)?.ready, true, 'A running story never returns to its startup loading screen');
    assert.equal(f.root.style.visibility, '');
  } finally { f.cleanup(); }
});

test('a valid placeholder cannot reveal the scene while authenticated asset bytes are pending', async () => {
  const f = fixture(), download = deferred<Blob>();
  setSandboxAssetLoader(() => download.promise);
  try {
    f.image.src = resolveSandboxAssetUrl('/vn-assets/pending-scene-test.svg');
    f.load(); f.decode.resolve(); f.start();
    await new Promise(done => setTimeout(done, 80));
    assert.equal(f.states.at(-1)?.ready, false, 'Transparent placeholder is not the real scene asset');
    download.resolve(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }));
    await new Promise(done => setTimeout(done, 80));
    assert.equal(f.states.at(-1)?.ready, false, 'Downloaded bytes still need to replace the placeholder');
    f.image.src = resolveSandboxAssetUrl('/vn-assets/pending-scene-test.svg');
    await until(() => f.states.at(-1)?.ready === true);
  } finally { f.cleanup(); }
});

test('failed startup assets stay covered and can recover without gating later scene changes', async () => {
  const f = fixture();
  try {
    f.start(); f.fail(); await until(() => f.states.at(-1)?.error === true);
    assert.equal(f.states.at(-1)?.ready, false); assert.equal(f.root.style.visibility, 'hidden');
    f.reset(); f.image.src = '/recovered.png';
    await until(() => f.states.at(-1)?.error !== true);
    f.load(); f.decode.resolve(); await until(() => f.states.at(-1)?.ready === true);
    f.reset(); f.image.src = '/last-pending.png';
    await new Promise(done => setTimeout(done, 50));
    assert.equal(f.states.at(-1)?.ready, true);
    f.cleanup();
    const before = f.states.length; await new Promise(done => setTimeout(done, 50));
    assert.equal(f.states.length, before, 'Unmounted scenes cannot emit readiness');
  } finally { f.cleanup(); }
});

test('unused inherited fonts do not block images, while a failed font used by visible text does', async () => {
  const f = fixture();
  let available = false;
  const fonts = Object.assign(new f.dom.window.EventTarget(), { status: 'loaded', ready: Promise.resolve(), check: () => available });
  Object.defineProperty(f.dom.window.document, 'fonts', { value: fonts });
  f.root.style.fontFamily = 'RequiredOnlyForText';
  const text = f.dom.window.document.createTextNode('Visible text needs its font.');
  f.root.append(text);
  try {
    f.load(); f.decode.resolve(); f.start();
    await until(() => f.states.at(-1)?.error === true);
    text.remove();
    await until(() => f.states.at(-1)?.ready === true);
    available = true; fonts.dispatchEvent(new f.dom.window.Event('loadingdone'));
  } finally { f.cleanup(); }
});

test('an off-screen prefetch cannot hold the displayed opening scene on its loading screen', async () => {
  const f = fixture();
  setSandboxAssetLoader(() => new Promise<Blob>(() => {}));
  try {
    resolveSandboxAssetUrl('/vn-assets/unrelated-prefetch.svg');
    f.load(); f.decode.resolve(); f.start();
    await until(() => f.states.at(-1)?.ready === true);
    assert.equal(f.root.style.visibility, '');
  } finally { f.cleanup(); }
});
