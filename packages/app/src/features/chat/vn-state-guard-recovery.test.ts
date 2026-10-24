import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { buildAPI } from "../../../sandbox/sandbox-context";
import { unwrapMessage, type ApiCallMessage } from "../../../sandbox/protocol";
import { upgradeVnStateGuardRecoveryFiles } from "./vn-state-guard-recovery-upgrade";

const directory = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(directory).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, directory), "utf8")]));
const renderer = readFileSync(new URL("./world-renderer.tsx", import.meta.url), "utf8");
const guardError = "State update check failed (correction_timeout). Your previous story state is saved. This reply was not charged Yumina mushies. Please retry.";
const oldButton = '<button onClick={() => api.openModelPicker()}>Choose model</button>';

function installDom(dom: JSDOM) {
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } };
}

async function mountError(error: string, settingsMethod = true) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://isolated.invalid" });
  const restore = installDom(dom);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const content = '[SPEAKER:NPC:normal] "The previous passage stays readable."';
  const calls = { guard: 0, story: 0, retry: [] as string[], sends: 0, changes: [] as string[] };
  const api = { sessionId: "guard-recovery", worldId: "fixture", worldName: "Fixture", variables: {}, entries: [],
    messages: [{ id: "old-reply", role: "assistant", content }, { id: "pending-user", role: "user", content: "Wait" }],
    pendingChoices: [], isStreaming: false, readOnly: false, error,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (text: string) => text, resolveAssetUrl: (asset: string) => asset,
    openStateGuardSettings: settingsMethod ? () => { calls.guard++; } : undefined,
    openModelPicker: () => { calls.story++; }, sendMessage: () => { calls.sends++; },
    retryPendingReply: (id: string) => { calls.retry.push(id); api.isStreaming = true; },
    deleteMessage: async (id: string) => { calls.changes.push(id); return true; },
  };
  const compiled = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(compiled.error, null);
  await act(async () => root.render(createElement(compiled.Component!)));
  const container = document.getElementById("root")!;
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(node => node.textContent?.trim() === label);
  return { calls, container, button, close: async () => { await act(async () => root.unmount()); dom.window.close(); restore(); } };
}

test("State Guard errors open correction settings and retain single pending-choice retry", async () => {
  for (const error of [guardError, "State update check failed (correction_model_unavailable).", "State update check failed (provider_unavailable).", "Not enough mushies for the state update correction."]) {
    const view = await mountError(error);
    try {
      const settings = view.button("State Update Guard settings");
      assert.ok(settings, "the failure offers the correction settings rather than the story picker");
      assert.equal(view.button("Choose model"), undefined);
      await act(async () => settings.click());
      assert.deepEqual(view.calls, { guard: 1, story: 0, retry: [], sends: 0, changes: [] });
      assert.ok(view.button("Choose something else"));
      const retry = view.button("Retry"); assert.ok(retry);
      await act(async () => { retry.click(); retry.click(); });
      assert.deepEqual(view.calls.retry, ["pending-user"]);
      assert.equal(view.calls.sends, 0);
    } finally { await view.close(); }
  }
});

test("ordinary errors retain the story picker and an older SDK gets explicit Guard guidance", async () => {
  for (const error of ["Custom endpoint request failed: fetch failed", ...["provider_refusal", "truncated_reply", "empty_story", "cancelled", "disabled_or_stale", "deadline", "unknown_error"].map(code => `State update check failed (${code}).`)]) {
    const ordinary = await mountError(error);
    try {
      const picker = ordinary.button("Choose model"); assert.ok(picker, error);
      assert.equal(ordinary.button("State Update Guard settings"), undefined, error);
      await act(async () => picker.click());
      assert.equal(ordinary.calls.story, 1); assert.equal(ordinary.calls.guard, 0);
    } finally { await ordinary.close(); }
  }
  const older = await mountError(guardError, false);
  try {
    assert.equal(older.button("Choose model"), undefined);
    assert.equal(older.button("State Update Guard settings"), undefined);
    assert.match(older.container.textContent ?? "", /Open State Update Guard from the app menu/);
    assert.equal(older.calls.story, 0); assert.equal(older.calls.sends, 0);
  } finally { await older.close(); }
});

test("the SDK posts a dedicated argument-free settings launcher only from an editable session", () => {
  const dom = new JSDOM("", { url: "https://isolated.invalid" }); const restore = installDom(dom);
  const messages: ApiCallMessage[] = [];
  dom.window.parent.postMessage = (data: unknown) => { const message = unwrapMessage<ApiCallMessage>(data); if (message) messages.push(message); };
  const state = { mode: "session" as const, sessionId: "session", readOnly: false, variables: {}, globalVariables: {}, messages: [], worldName: "Fixture", worldId: "world", capabilities: { canUseSessionApis: true, canPersistSession: true, canSendMessage: true, requiresAuth: false } };
  try {
    const api = buildAPI(state as unknown as Parameters<typeof buildAPI>[0]);
    assert.equal(typeof api.openStateGuardSettings, "function"); api.openStateGuardSettings();
    assert.deepEqual(messages.map(message => [message.method, message.args]), [["openStateGuardSettings", []]]);
    for (const patch of [{ readOnly: true }, { sessionId: "" }, { mode: "guest-preview" }, { capabilities: { ...state.capabilities, canUseSessionApis: false } }]) {
      buildAPI({ ...state, ...patch } as unknown as Parameters<typeof buildAPI>[0]).openStateGuardSettings();
    }
    assert.equal(messages.length, 1);
  } finally { dom.window.close(); restore(); }
});

test("the host launcher rejects stale, hidden, preview, read-only and unavailable sessions", () => {
  const body = renderer.match(/case "openStateGuardSettings": \{([\s\S]*?)\n        \}/)?.[1];
  assert.ok(body, "the host must explicitly route the dedicated launcher");
  const code = transform(`function run(){${body}}`, { transforms: ["typescript"] }).code;
  const invoke = new Function("mode", "isActive", "sessionIdRef", "capabilities", "currentApi", "useChatStore", "window", "CustomEvent", code + ";return run();");
  const state = { mode: "session", isActive: true, sessionId: "session", storeSessionId: "session", canUseSessionApis: true, frameReadOnly: false, storeReadOnly: false };
  let opens = 0;
  const dispatch = { dispatchEvent: (event: Event) => { assert.equal(event.type, "yumina:request-state-guard"); opens++; } };
  const run = (patch: Partial<typeof state>) => { const value = { ...state, ...patch }; invoke(value.mode, value.isActive, { current: value.sessionId }, { canUseSessionApis: value.canUseSessionApis }, { readOnly: value.frameReadOnly }, { getState: () => ({ session: { id: value.storeSessionId }, readOnly: value.storeReadOnly }) }, dispatch, Event); };
  run({}); assert.equal(opens, 1);
  for (const patch of [{ mode: "guest-preview" }, { isActive: false }, { sessionId: "" }, { storeSessionId: "other" }, { canUseSessionApis: false }, { frameReadOnly: true }, { storeReadOnly: true }]) run(patch);
  assert.equal(opens, 1);
});

test("stock saved readers gain recovery while custom error controls remain intact", () => {
  const before = readFileSync(new URL('../../../../../interfaces/vn/index.tsx', import.meta.url), "utf8");
  const oldRoot = before.replace(/      \{\/\^\(\?:State update check failed[\s\S]*?\}\n(?=      \{operationError)/, '      ' + oldButton + '\n');
  const original = { "index.tsx": oldRoot, "ui/story.tsx": oldRoot, "styles.ts": "creator CSS", "story.ts": "creator story" };
  const next = upgradeVnStateGuardRecoveryFiles(original);
  assert.notEqual(next, original);
  assert.match(next["index.tsx"], /State Update Guard settings/);
  assert.equal(next["index.tsx"], before);
  assert.equal(next["ui/story.tsx"], before);
  assert.equal(next["styles.ts"], original["styles.ts"]);
  assert.equal(next["story.ts"], original["story.ts"]);
  assert.equal(upgradeVnStateGuardRecoveryFiles(next), next);
  for (const source of [oldRoot.replace(oldButton, oldButton.replace('api.openModelPicker()', 'openCreatorPicker()')), oldRoot.replace('disabled={api.isStreaming} onClick={retryResponse}>Retry', 'disabled={api.isStreaming} onClick={creatorRetry}>Retry'), oldRoot.replace('className="vn-error"', 'className="creator-error"'), oldRoot + oldRoot]) {
    const custom = { "index.tsx": source }; assert.equal(upgradeVnStateGuardRecoveryFiles(custom), custom);
  }
});
