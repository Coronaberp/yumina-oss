import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Message, SessionData } from "./chat";

const appRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const stubs: Record<string, string> = {
  "@/lib/sse": "export function connectSSE(url, options) { globalThis.__storyEndingSSE = { url, ...options }; return new AbortController(); }",
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
    name: "story-ending-runtime-stubs", enforce: "pre",
    resolveId(id) {
      if (id === "/src/stores/chat.ts") return `${appRoot}/src/stores/chat.ts`;
      const key = Object.keys(stubs).find(k => k === id || (k.startsWith("@/") && id === k.replace("@", `${appRoot}/src`)));
      return key ? `\0story-ending:${key}` : null;
    },
    load(id) {
      return id.startsWith("\0story-ending:") ? stubs[id.slice("\0story-ending:".length)] : null;
    },
  }],
});
const { useChatStore: store } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const { useConfigStore: config } = await vite.ssrLoadModule("/src/stores/config.ts") as typeof import("./config");
const session = { id: "s1", worldId: "w1", state: { variables: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as SessionData;
const assistant: Message = { id: "a1", sessionId: "s1", role: "assistant", status: "complete", content: "The final scene.", createdAt: new Date().toISOString(), activeSwipeIndex: 0, swipes: [{ content: "The final scene.", choices: [], createdAt: new Date().toISOString() }] };
const pending = { status: "ending-ready", ending: { id: "e1", name: "Dawn", outcome: "won", mode: "authored", prose: "", guidance: "", selectedTurn: 2, operationId: "op-1" } } as any;
let endingCalls = 0;
let lastBody: Record<string, unknown> | null = null;
let endingResponder: () => Response | Promise<Response> = () => Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: pending.ending, presentation: "The end." } }, message: { id: "a1", sessionId: "s1", role: "assistant", status: "complete", content: "The end.", createdAt: new Date().toISOString() } } });
const oldFetch = globalThis.fetch;

beforeEach(() => {
  endingCalls = 0;
  lastBody = null;
  endingResponder = () => Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: pending.ending, presentation: "The end." } }, message: { id: "a1", sessionId: "s1", role: "assistant", status: "complete", content: "The end.", createdAt: new Date().toISOString() } } });
  config.setState({ selectedModel: "fixture-model", mixMode: false });
  store.setState({ session, messages: [structuredClone(assistant)], storyProgress: { status: "playing" } as any, isCompletingEnding: false, endingError: null, isStreaming: false, readOnly: false, error: null, pendingChoices: [], modelFallback: null });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture.local");
    if (url.pathname.endsWith("/ending")) { endingCalls++; lastBody = JSON.parse(String(init?.body ?? "{}")); return endingResponder(); }
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/api/sessions/s1") {
      return Response.json({ data: { ...session, state: { variables: {}, story: pending }, messages: [assistant], messageTotal: 1, world: { schema: {} } } });
    }
    throw new Error(`Unexpected ${init?.method} ${url.pathname}`);
  };
});

after(async () => { globalThis.fetch = oldFetch; await vite.close(); });

test("reload hydrates pending ending without automatically calling paid completion", async () => {
  await store.getState().loadSession("s1");
  assert.equal(store.getState().storyProgress.status, "ending-ready");
  assert.equal(endingCalls, 0);
});

test("completion targets latest assistant and persists the returned closing message", async () => {
  store.setState({ storyProgress: pending });
  await store.getState().completeEnding();
  assert.equal(endingCalls, 1);
  assert.deepEqual(lastBody, { operationId: "op-1", messageId: "a1", activeSwipeIndex: 0, model: "fixture-model" });
  assert.equal(store.getState().storyProgress.status, "completed");
  assert.equal(store.getState().messages.at(-1)?.id, "a1");
  assert.equal(store.getState().messages.at(-1)?.content, "The end.");
  assert.equal(store.getState().messages.length, 1);
  assert.deepEqual(store.getState().pendingChoices, []);
});

test("duplicate completion clicks issue one request", async () => {
  store.setState({ storyProgress: pending });
  let resolve!: (response: Response) => void;
  endingResponder = () => new Promise<Response>(r => { resolve = r; });
  const first = store.getState().completeEnding();
  const second = store.getState().completeEnding();
  assert.equal(endingCalls, 1);
  resolve(Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: pending.ending } }, message: { id: "a1", role: "assistant", status: "complete", content: "Done" } } }));
  await Promise.all([first, second]);
  assert.equal(store.getState().storyProgress.status, "completed");
});

test("failure keeps ending pending and exposes retry error", async () => {
  store.setState({ storyProgress: pending });
  endingResponder = () => Response.json({ error: "Provider failed" }, { status: 502 });
  await assert.rejects(store.getState().completeEnding(), /Provider failed/);
  assert.equal(store.getState().storyProgress.status, "ending-ready");
  assert.equal(store.getState().endingError, "Provider failed");
  assert.equal(store.getState().isCompletingEnding, false);
});

test("stale session response is ignored", async () => {
  store.setState({ storyProgress: pending });
  let resolve!: (response: Response) => void;
  endingResponder = () => new Promise<Response>(r => { resolve = r; });
  const request = store.getState().completeEnding();
  store.setState({ session: { ...session, id: "s2" } as SessionData, storyProgress: { status: "playing" } as any, messages: [] });
  resolve(Response.json({ data: { state: { variables: {}, story: { status: "completed", ending: pending.ending } }, message: { id: "a1", role: "assistant", status: "complete", content: "stale" } } }));
  await assert.rejects(request, /session changed/);
  assert.equal(store.getState().messages.length, 0);
  assert.equal(store.getState().storyProgress.status, "playing");
});

test("terminal state blocks ordinary generation and choices", async () => {
  store.setState({ storyProgress: { status: "completed" } as any });
  store.getState().sendMessage("after");
  store.getState().continueLastMessage();
  await assert.rejects(store.getState().generateChoices("a1"), /ending/);
  assert.equal(endingCalls, 0);
});

test("a committed turn completes its ending once, and reload never repeats it", async () => {
  const capture = globalThis as typeof globalThis & { __storyEndingSSE?: { callbacks: { onDone: (data: Record<string, unknown>) => void } } };
  Reflect.deleteProperty(capture, "__storyEndingSSE");
  store.getState().sendMessage("Return home");
  for (let i = 0; i < 40 && !capture.__storyEndingSSE; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(capture.__storyEndingSSE, "ordinary turn request started");
  capture.__storyEndingSSE.callbacks.onDone({
    messageId: "a1", userMessageId: "u1", content: "The final scene.",
    state: { variables: {}, story: pending }, choices: [],
  });
  for (let i = 0; i < 40 && store.getState().isCompletingEnding; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(endingCalls, 1);
  assert.equal(store.getState().storyProgress.status, "completed");
  assert.equal(store.getState().messages.at(-1)?.content, "The end.");
  assert.equal(store.getState().messages.filter(message => message.role === "user").length, 1);
  await store.getState().loadSession("s1");
  assert.equal(endingCalls, 1, "reload must not make another completion request");
});

for (const mode of ["regenerate", "continue"] as const) {
  test(`${mode} completion targets its committed reply without another player action`, async () => {
    const capture = globalThis as typeof globalThis & { __storyEndingSSE?: { callbacks: { onDone: (data: Record<string, unknown>) => void } } };
    Reflect.deleteProperty(capture, "__storyEndingSSE");
    const ready = { ...pending, ending: { ...pending.ending, operationId: `op-${mode}` } };
    const replyId = mode === "regenerate" ? assistant.id : "continued-1";
    const swipeIndex = mode === "regenerate" ? 1 : 0;
    endingResponder = () => Response.json({ data: {
      state: { variables: {}, story: { ...ready, status: "completed", presentation: "The end." } },
      message: { ...assistant, id: replyId, activeSwipeIndex: swipeIndex, content: "The end." },
    } });
    if (mode === "regenerate") store.getState().regenerateMessage(assistant.id);
    else store.getState().continueLastMessage();
    for (let i = 0; i < 40 && !capture.__storyEndingSSE; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(capture.__storyEndingSSE, "ordinary scene request started");
    capture.__storyEndingSSE.callbacks.onDone({
      messageId: replyId, content: "The committed closing scene.", swipeIndex,
      totalSwipes: swipeIndex + 1, state: { variables: {}, story: ready }, choices: [],
    });
    for (let i = 0; i < 40 && store.getState().isCompletingEnding; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(endingCalls, 1);
    assert.equal(store.getState().storyProgress.status, "completed");
    assert.equal(store.getState().messages.at(-1)?.content, "The end.");
    assert.deepEqual(lastBody, { operationId: `op-${mode}`, messageId: replyId, activeSwipeIndex: swipeIndex, model: "fixture-model" });
    assert.equal(store.getState().messages.filter(message => message.role === "user").length, 0);
    assert.equal(store.getState().messages.filter(message => message.id === replyId).length, 1);
  });
}
