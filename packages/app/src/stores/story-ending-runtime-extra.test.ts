import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const engineRoot = appRoot + "/../engine/src/index.ts";
const stubs: Record<string, string> = {
  "@/lib/auth-guard": "export function handleAuthLoss() {}",
  "@/lib/feedback": "export const feedback = { notice() {}, error() {}, warning() {} };",
  "@/lib/i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
  "./i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
};
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": engineRoot } },
  plugins: [{
    name: "story-ending-extra-stubs", enforce: "pre",
    resolveId(id) {
      const key = Object.keys(stubs).find(k => k === id || (k.startsWith("@/") && id === k.replace("@", `${appRoot}/src`)));
      return key ? `\0story-ending-extra:${key}` : null;
    },
    load(id) { return id.startsWith("\0story-ending-extra:") ? stubs[id.slice("\0story-ending-extra:".length)] : null; },
  }],
});
const chat = await vite.ssrLoadModule("/src/stores/chat.ts") as any;
const { useConfigStore: config } = await vite.ssrLoadModule("/src/stores/config.ts") as any;
const store = chat.useChatStore;
const session = { id: "s-extra", worldId: "w-extra", state: { variables: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const stamp = () => new Date().toISOString();
const baseAssistant = () => ({ id: "reply-1", sessionId: session.id, role: "assistant", status: "complete", content: "Old reply", createdAt: stamp(), activeSwipeIndex: 0, swipes: [{ content: "Old reply", rawContent: "Old reply", choices: ["old choice"], createdAt: stamp() }] });
const ending = { id: "ending-1", name: "Dawn", outcome: "won", mode: "authored", prose: "", guidance: "", selectedTurn: 2, operationId: "operation-1" };
const pending = () => ({ status: "ending-ready", ending: structuredClone(ending) });
let responder: () => Response | Promise<Response>;
const oldFetch = globalThis.fetch;

beforeEach(() => {
  config.setState({ selectedModel: "fixture-model", mixMode: false });
  store.setState({ session: structuredClone(session), messages: [baseAssistant()], storyProgress: pending(), isCompletingEnding: false, endingError: null, isStreaming: false, readOnly: false, error: null, pendingChoices: [], modelFallback: null });
  responder = () => Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: structuredClone(ending), presentation: "The end." } }, message: { ...baseAssistant(), content: "The end.", swipes: [{ content: "The end.", choices: [], createdAt: stamp() }] } } });
  globalThis.fetch = async (_input, _init) => responder();
});

after(async () => { globalThis.fetch = oldFetch; await vite.close(); });

test("same-id completion replaces prose and active swipe without duplicating the reply", async () => {
  await store.getState().completeEnding();
  const messages = store.getState().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "reply-1");
  assert.equal(messages[0].content, "The end.");
  assert.equal(messages[0].swipes?.[0]?.content, "The end.");
  assert.deepEqual(messages[0].swipes?.[0]?.choices, []);
  assert.equal(store.getState().storyProgress.status, "completed");
});

test("malformed success stays pending and leaves the previous reply intact", async () => {
  responder = () => Response.json({ data: { state: { variables: {}, story: { status: "ending-ready", ending: structuredClone(ending) } }, message: { id: "wrong-id", role: "assistant", status: "complete", content: "forged" } } });
  await assert.rejects(store.getState().completeEnding(), /incomplete/);
  assert.equal(store.getState().storyProgress.status, "ending-ready");
  assert.equal(store.getState().messages[0].content, "Old reply");
  assert.match(store.getState().endingError ?? "", /incomplete/);
});

test("same-session operation or active-swipe changes reject an in-flight response", async () => {
  let resolve!: (response: Response) => void;
  responder = () => new Promise<Response>(r => { resolve = r; });
  const request = store.getState().completeEnding();
  store.setState({ storyProgress: { status: "ending-ready", ending: { ...ending, operationId: "operation-2" } }, messages: [{ ...baseAssistant(), activeSwipeIndex: 1, swipes: [{ content: "Old reply", choices: ["old choice"], createdAt: stamp() }, { content: "Other swipe", choices: [], createdAt: stamp() }] }] });
  resolve(Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: structuredClone(ending) } }, message: { ...baseAssistant(), content: "The end." } } }));
  await assert.rejects(request, /session changed/);
  assert.equal(store.getState().storyProgress.status, "ending-ready");
  assert.equal(store.getState().storyProgress.ending.operationId, "operation-2");
  assert.equal(store.getState().messages[0].activeSwipeIndex, 1);
});
