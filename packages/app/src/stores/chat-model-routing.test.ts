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
const routing = { requestedModel: "custom/selected", routedModel: "custom/routed", reason: "content-fallback" as const };

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
    if (init?.method === "POST" && (url.pathname === "/api/sessions/s1/messages" || url.pathname.endsWith("/regenerate") || url.pathname.endsWith("/continue"))) {
      const regenerate = url.pathname.endsWith("/regenerate");
      const body = { messageId: regenerate ? "opening" : "reply", userMessageId: "player", content: "A freshly finished scene", rawContent: "A freshly finished scene", choices: [], model: routing.routedModel, modelRouting: routing, state: { variables: {} }, swipeIndex: regenerate ? 1 : 0, totalSwipes: regenerate ? 2 : 1 };
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

for (const action of ["send", "regenerate", "continue"] as const) {
  test(`${action} mirrors server routing metadata to the accepted active swipe`, async () => {
    const accepted = await completeStream(() => {
      if (action === "send") store.getState().sendMessage("Enter");
      else if (action === "regenerate") store.getState().regenerateMessage(opening.id);
      else store.getState().continueLastMessage();
    });
    assert.deepEqual(accepted.modelRouting, routing);
    assert.deepEqual(accepted.swipes?.[accepted.activeSwipeIndex ?? 0]?.modelRouting, routing);
    assert.equal(accepted.model, routing.routedModel);
    assert.equal(config.getState().selectedModel, "fixture-model", "routing does not change next-reply selection");
  });
}
