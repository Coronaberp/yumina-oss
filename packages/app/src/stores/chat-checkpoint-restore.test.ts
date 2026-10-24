import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { Message, SessionData } from "./chat";

const previousFetch = globalThis.fetch;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const stubs: Record<string, string> = {
  "@/lib/auth-guard": "export function handleAuthLoss() {}",
  "@/lib/feedback": "export const feedback = { notice() {}, error() {}, warning() {} };",
  "@/lib/i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
  "./i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
};
const cacheDir = mkdtempSync(join(tmpdir(), "vn-checkpoint-test-"));
const vite = await createServer({
  cacheDir,
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
  plugins: [{
    name: "checkpoint-test-ui-stubs", enforce: "pre",
    resolveId(id) {
      const key = Object.keys(stubs).find(key => key === id || (key.startsWith("@/") && id === key.replace("@", `${appRoot}/src`)));
      return key ? `\0checkpoint-test:${key}` : null;
    },
    load(id) { return id.startsWith("\0checkpoint-test:") ? stubs[id.slice("\0checkpoint-test:".length)] : null; },
  }],
});
const { useChatStore: store } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const session: SessionData = { id: "s1", worldId: "world", state: { variables: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const opening: Message = { id: "opening", sessionId: session.id, role: "assistant", status: "complete", content: "Welcome", createdAt: new Date().toISOString(), swipes: [{ content: "Welcome", choices: [], createdAt: new Date().toISOString() }], activeSwipeIndex: 0 };

beforeEach(() => {
  memory.clear(); memory.set('vn:settings', 'preserved');
  store.setState({ session, messages: [structuredClone(opening)], gameState: { hp: 9 }, storyProgress: { status: 'playing' }, isStreaming: false });
});
after(async () => {
  globalThis.fetch = previousFetch;
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  try {
    await vite.close();
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
for (const failure of ['http', 'network']) {
  test(`checkpoint ${failure} failures reject and preserve the active story`, async () => {
    const messages = store.getState().messages, state = store.getState().gameState;
    globalThis.fetch = async () => { if (failure === 'network') throw new Error('Network failed'); return Response.json({ error: 'Not found' }, { status: 404 }); };
    await assert.rejects(store.getState().restoreCheckpoint('missing'), /checkpoint/i);
    assert.equal(store.getState().messages, messages); assert.equal(store.getState().gameState, state);
    assert.equal(memory.get('vn:settings'), 'preserved');
  });
}
test('unavailable checkpoint restore rejects before sending a request', async () => {
  store.setState({ isStreaming: true });
  globalThis.fetch = async () => { throw new Error('Must not fetch while streaming'); };
  await assert.rejects(store.getState().restoreCheckpoint('saved'), /unavailable/i);
});
test('checkpoint restoration cannot replace a newly selected session', async () => {
  let resolve!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
  const request = store.getState().restoreCheckpoint('saved');
  const other = [{ ...opening, id: 'other', sessionId: 'other-session' }];
  store.setState({ session: { ...session, id: 'other-session' }, messages: other });
  resolve(Response.json({ data: { messages: [opening], state: { variables: { hp: 5 } } } }));
  await assert.rejects(request, /session changed/i);
  assert.equal(store.getState().messages, other);
});
test('checkpoint success restores its server snapshot without changing browser preferences', async () => {
  const restored = { ...opening, content: 'Saved scene' };
  globalThis.fetch = async () => Response.json({ data: { messages: [restored], state: { variables: { hp: 5 }, story: { status: 'playing' } } } });
  await store.getState().restoreCheckpoint('saved');
  assert.deepEqual(store.getState().messages, [restored]);
  assert.deepEqual(store.getState().gameState, { hp: 5 });
  assert.equal(memory.get('vn:settings'), 'preserved');
});

for (const action of ['save', 'list']) {
  test(`late checkpoint ${action} response cannot replace another session's checkpoint list`, async () => {
    let resolve!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
    const request = action === 'save' ? store.getState().saveCheckpoint() : store.getState().loadCheckpoints();
    const other = [{ id: 'other-checkpoint', name: 'Other story', messageCount: 2, createdAt: '2026-10-22T00:00:00Z' }];
    store.setState({ session: { ...session, id: 'other-session' }, checkpoints: other });
    const saved = { id: 'old-checkpoint', name: 'Old story', messageCount: 1, createdAt: '2026-10-22T00:00:00Z' };
    resolve(Response.json({ data: action === 'save' ? saved : [saved] }));
    await assert.rejects(request, /session changed/i);
    assert.equal(store.getState().checkpoints, other);
  });
}

for (const streaming of [true, false]) {
  test(`late checkpoint restore preserves a new ${streaming ? 'streaming' : 'finished'} timeline`, async () => {
    let resolve!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
    const request = store.getState().restoreCheckpoint('saved');
    const newer = [opening, { ...opening, id: 'new-reply', content: 'A new timeline' }];
    store.setState({ messages: newer, isStreaming: streaming });
    resolve(Response.json({ data: { messages: [opening], state: { variables: { hp: 5 } } } }));
    await assert.rejects(request, /checkpoint/i);
    assert.equal(store.getState().messages, newer);
    assert.equal(store.getState().isStreaming, streaming);
    assert.deepEqual(store.getState().gameState, { hp: 9 });
  });
}
