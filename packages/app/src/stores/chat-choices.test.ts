import assert from "node:assert/strict";
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
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
  plugins: [{
    name: "choices-test-ui-stubs", enforce: "pre",
    resolveId(id) {
      const key = Object.keys(stubs).find(key => key === id || (key.startsWith("@/") && id === key.replace("@", `${appRoot}/src`)));
      return key ? `\0choices-test:${key}` : null;
    },
    load(id) { return id.startsWith("\0choices-test:") ? stubs[id.slice("\0choices-test:".length)] : null; },
  }],
});
const { useChatStore: store } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const { useConfigStore: config } = await vite.ssrLoadModule("/src/stores/config.ts") as typeof import("./config");
const session: SessionData = { id: "s1", worldId: "world", state: { variables: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const opening: Message = { id: "opening", sessionId: session.id, role: "assistant", status: "complete", content: "Welcome", createdAt: new Date().toISOString(), swipes: [{ content: "Welcome", choices: [], createdAt: new Date().toISOString() }], activeSwipeIndex: 0 };
let choiceCalls = 0;

beforeEach(() => {
  memory.clear(); choiceCalls = 0;
  config.setState({ selectedModel: "fixture-model", mixMode: false });
  store.setState({ session, messages: [structuredClone(opening)], readOnly: false, isStreaming: false, error: null, modelFallback: null, pendingChoices: [] });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture.local");
    if (url.pathname.endsWith("/generate-choices")) {
      choiceCalls++;
      const body = JSON.parse(init?.body as string);
      return Response.json({ data: { messageId: url.pathname.split("/").at(-2), activeSwipeIndex: body.activeSwipeIndex, choices: ["Stay", "Leave"] } });
    }
    if (init?.method === "POST" && (url.pathname === "/api/sessions/s1/messages" || url.pathname.endsWith("/regenerate"))) {
      const regenerate = url.pathname.endsWith("/regenerate");
      const body = { messageId: regenerate ? "opening" : "reply", userMessageId: "player", content: "A freshly finished scene", rawContent: "A freshly finished scene", choices: [], state: { variables: {} }, swipeIndex: regenerate ? 1 : 0, totalSwipes: regenerate ? 2 : 1 };
      return new Response(`event: done\ndata: ${JSON.stringify(body)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
  };
});

after(async () => {
  globalThis.fetch = previousFetch;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  await vite.close();
});

async function completeStream(action: () => void) {
  const done = new Promise<void>(resolve => {
    const unsubscribe = store.subscribe(state => {
      if (!state.isStreaming) { unsubscribe(); resolve(); }
    });
  });
  action();
  await done;
  assert.equal(store.getState().error, null);
  return store.getState().messages.at(-1)!;
}

for (const action of ["send", "continue", "regenerate"] as const) {
  test(`${action} shows progress before completion and clears it for the next attempt`, async () => {
    store.setState({ streamingTokenCount: 999 });
    const encoder = new TextEncoder();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
    let progressReady!: () => void;
    const ready = new Promise<void>(resolve => { progressReady = resolve; });
    const unsubscribe = store.subscribe(state => { if (state.streamingTokenCount === 128) progressReady(); });
    const done = completeStream(() => {
      if (action === "send") store.getState().sendMessage("Enter");
      else if (action === "continue") store.getState().continueLastMessage();
      else store.getState().regenerateMessage(opening.id);
    });
    assert.equal(store.getState().streamingTokenCount, null, "starting clears the previous count");
    for (let i = 0; i < 12 && !body; i++) await new Promise(resolve => setImmediate(resolve));
    body.enqueue(encoder.encode('event: progress\ndata: {"tokens":128}\n\n'));
    await ready;
    assert.equal(store.getState().isStreaming, true);
    assert.equal(store.getState().streamingContent, "", "story text is still buffered");
    body.enqueue(encoder.encode('event: done\ndata: {"messageId":"reply","content":"Finished","state":{"variables":{}}}\n\n'));
    body.close();
    await done;
    unsubscribe();
    assert.equal(store.getState().streamingTokenCount, null, "completion clears progress");
  });

  test(`${action} completion allows generating choices immediately without reloading`, async () => {
    if (action === "regenerate") store.setState({ messages: [{ ...opening, status: "failed", errorMessage: "Previous attempt failed" }] });
    const reply = await completeStream(() => {
      if (action === "send") store.getState().sendMessage("Enter");
      else if (action === "continue") store.getState().continueLastMessage();
      else store.getState().regenerateMessage(opening.id);
    });
    assert.equal(reply.status, "complete");
    assert.ok(!reply.errorMessage);
    assert.deepEqual(await store.getState().generateChoices(reply.id), ["Stay", "Leave"]);
    assert.equal(choiceCalls, 1);
    assert.equal(store.getState().messages.at(-1)!.content, reply.content);
    assert.deepEqual(store.getState().pendingChoices, ["Stay", "Leave"]);
  });
}

test("failed, streaming and historical replies remain ineligible for choice generation", async () => {
  for (const status of ["failed", "streaming"] as const) {
    store.setState({ messages: [{ ...opening, status }] });
    await assert.rejects(store.getState().generateChoices(opening.id), /completed reply/);
  }
  store.setState({ messages: [opening, { ...opening, id: "newer" }] });
  await assert.rejects(store.getState().generateChoices(opening.id), /completed reply/);
  assert.equal(choiceCalls, 0);
});

test("HTML API failures show an actionable error without changing the scene and allow retry", async () => {
  const before = structuredClone(store.getState().messages);
  const originalFixtureFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    choiceCalls++;
    return new Response("<!DOCTYPE html><html>Fallback web page</html>", { headers: { "Content-Type": "text/html" } });
  };
  await assert.rejects(store.getState().generateChoices(opening.id), /Choices API returned a web page instead of JSON/);
  assert.deepEqual(store.getState().messages, before);
  assert.deepEqual(store.getState().pendingChoices, []);
  assert.equal(choiceCalls, 1);
  globalThis.fetch = originalFixtureFetch;
  assert.deepEqual(await store.getState().generateChoices(opening.id), ["Stay", "Leave"]);
  assert.equal(choiceCalls, 2);
});
