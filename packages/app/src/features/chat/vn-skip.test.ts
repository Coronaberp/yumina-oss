import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradeVnSkipFiles } from "./vn-skip-upgrade";

const directory = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(directory).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, directory), "utf8")]));
const content = (turn: number, pages: number) => Array.from({ length: pages }, (_, index) => `*Turn ${turn}, passage ${index + 1}.*`).join("\n\n");
const reply = (turn: number, pages = 3) => ({ id: `reply-${turn}`, role: "assistant", status: "complete", content: content(turn, pages), activeSwipeIndex: 0, swipes: [{ content: content(turn, pages), choices: [`Choice from turn ${turn}`, "Wait"] }] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Exercise mutable SDK snapshots without any live session or provider.
async function setup(overrides: Record<string, any> = {}, cardFiles = files) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://isolated.invalid" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const requests: string[] = [];
  const writes: Array<[string, string]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The fixture exposes the real reader's SDK surface.
  const api: any = {
    sessionId: "skip-test", worldId: "world", worldName: "Skip test", variables: {}, entries: [], user: { name: "QA" },
    messages: Array.from({ length: 15 }, (_, index) => reply(index + 1, index === 14 ? 37 : 3)),
    pendingChoices: ["Latest choice", "Wait"], isStreaming: false, error: null, hasEarlierMessages: true, readOnly: false,
    storage: { get: async (key: string) => key.endsWith(":cursor") ? JSON.stringify({ turn: "reply-12:0", index: 1 }) : null, set: async (key: string, value: string) => { writes.push([key, value]); } },
    renderMarkdown: (text: string) => text, resolveAssetUrl: (asset: string) => asset,
    sendMessage: (text: string) => { requests.push(`send:${text}`); },
    continueLastMessage: () => { requests.push("continue"); }, retryPendingReply: () => { requests.push("retry"); },
    generateChoices: () => { requests.push("generateChoices"); }, deleteMessage: () => { requests.push("delete"); },
    loadEarlierMessages: () => { requests.push("loadEarlier"); },
    ...overrides,
  };
  const compiled = bundleAndCompile({ files: cardFiles, entryFile: "index.tsx" }, () => api);
  assert.equal(compiled.error, null, compiled.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(compiled.Component!))); };
  const click = async (selector: string, times = 1) => {
    const node = container.querySelector<HTMLElement>(selector); assert.ok(node, selector);
    await act(async () => { for (let index = 0; index < times; index++) node.click(); });
  };
  const back = async () => { await act(async () => container.querySelector(".vn-stage")!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }))); };
  const position = () => container.querySelector(".vn-progress-summary")?.textContent ?? "";
  const text = () => container.querySelector(".vn-text")?.textContent ?? "";
  const close = async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  };
  await render();
  return { api, container, render, click, back, position, text, close, requests, writes };
}

test("one Skip jumps from historical turn 12 to page 37 of latest turn 15 and its choices", async () => {
  const view = await setup();
  const before = JSON.stringify({ messages: view.api.messages, variables: view.api.variables });
  try {
    assert.match(view.position(), /Turn 12 \| Page 2 of 3/);
    assert.equal(view.container.querySelector(".vn-choices"), null);
    await view.click('[aria-label="Skip"]');
    assert.match(view.position(), /Turn 15 \| Page 37 of 37/);
    assert.equal(view.text(), "Turn 15, passage 37.");
    assert.match(view.container.querySelector(".vn-choices")?.textContent ?? "", /Latest choice/);
    assert.doesNotMatch(view.container.querySelector(".vn-choices")?.textContent ?? "", /Choice from turn 12/);
    await view.click('[aria-label="Skip"]', 3);
    assert.match(view.position(), /Turn 15 \| Page 37 of 37/);
    assert.deepEqual(view.requests, []);
    assert.equal(JSON.stringify({ messages: view.api.messages, variables: view.api.variables }), before);
    assert.ok(view.writes.some(([key, value]) => key.endsWith(":cursor") && value === JSON.stringify({ turn: "reply-15:0", index: 36 })));
  } finally { await view.close(); }
});

test("Skip uses latest structured segments and active swipe rather than historical page counts", async () => {
  const latest = { ...reply(15, 37), activeSwipeIndex: 1 };
  const view = await setup({ messages: [reply(12), latest], variables: { segments: Array.from({ length: 7 }, (_, index) => ({ speaker: "Narrator", text: `*Accepted segment ${index + 1}.*` })) } });
  try {
    await view.click('[aria-label="Skip"]');
    assert.match(view.position(), /Turn 2 \| Page 7 of 7/);
    assert.equal(view.text(), "Accepted segment 7.");
    assert.ok(view.writes.some(([, value]) => value === JSON.stringify({ turn: "reply-15:1", index: 6 })));
    assert.deepEqual(view.requests, []);
  } finally { await view.close(); }
});

test("an upgraded saved cut performs the same historical jump without requests", async () => {
  const stockSkip = '<Control name="Skip" onClick={() => { setAuto(false); if (pendingPlayerSprite) setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current); else setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />';
  const oldFiles = { ...files, "index.tsx": files["index.tsx"].replace(/<Control name="Skip" onClick=\{\(\) => \{[\s\S]*?\}\} \/>/, stockSkip) };
  const updated = upgradeVnSkipFiles(oldFiles);
  assert.notEqual(updated, oldFiles);
  const view = await setup({}, updated);
  try {
    await view.click('[aria-label="Skip"]', 2);
    assert.match(view.position(), /Turn 15 \| Page 37 of 37/);
    assert.match(view.container.querySelector(".vn-choices")?.textContent ?? "", /Latest choice/);
    assert.deepEqual(view.requests, []);
  } finally { await view.close(); }
});

test("Skip with no history handles a greeting and an empty reader without generating", async () => {
  for (const greetingContent of ["*First.*\n\n*Last.*", ""]) {
    const view = await setup({ messages: [], greetingContent, pendingChoices: [], hasEarlierMessages: false });
    try {
      await view.click('[aria-label="Skip"]', 2);
      assert.equal(view.text(), greetingContent ? "Last." : "");
      assert.deepEqual(view.requests, []);
    } finally { await view.close(); }
  }
});

test("ordinary advance, backward navigation and Log remain available around Skip", async () => {
  const view = await setup();
  try {
    await view.click(".vn-stage");
    assert.match(view.position(), /Turn 12 \| Page 3 of 3/);
    await view.click(".vn-stage");
    assert.match(view.position(), /Turn 13 \| Page 1 of 3/);
    await view.click('[aria-label="Log"]');
    assert.ok(view.container.querySelector(".vn-log"));
    await view.click('[aria-label="Close log"]');
    assert.match(view.position(), /Turn 13 \| Page 1 of 3/);
    await view.click('[aria-label="Skip"]');
    await view.back();
    assert.match(view.position(), /Turn 15 \| Page 36 of 37/);
    assert.equal(view.container.querySelector(".vn-choices"), null);
    assert.deepEqual(view.requests, []);
  } finally { await view.close(); }
});

test("generation keeps streaming text and segments buffered when Skip returns from history", async () => {
  const view = await setup();
  try {
    view.api.isStreaming = true;
    view.api.messages = [...view.api.messages, { id: "pending-user", role: "user", content: "Already sent" }, { id: "streaming", role: "assistant", content: "UNACCEPTED OUTPUT" }];
    view.api.variables = { segments: [{ speaker: "Narrator", text: "UNACCEPTED SEGMENT" }] };
    await view.render();
    await view.click('[aria-label="Skip"]', 2);
    assert.match(view.position(), /Turn 15 \| Page 37 of 37/);
    assert.equal(view.text(), "Turn 15, passage 37.");
    assert.equal(view.container.querySelector(".vn-choices"), null);
    assert.doesNotMatch(view.container.textContent ?? "", /UNACCEPTED/);
    assert.deepEqual(view.requests, []);
  } finally { await view.close(); }
});

test("Skip preserves a pending player choice until a completed reply is ready, then reaches its final page", async () => {
  const view = await setup({ storage: { get: async () => null, set: async () => {} }, hasEarlierMessages: false });
  try {
    await view.click('[aria-label="Skip"]');
    await view.click(".vn-choice");
    assert.deepEqual(view.requests, ["send:Latest choice"]);
    const pendingText = view.text();
    view.api.messages = [...view.api.messages, { id: "pending-user", role: "user", content: "Latest choice" }];
    view.api.isStreaming = true;
    await view.render();
    await view.click('[aria-label="Skip"]', 2);
    assert.equal(view.text(), pendingText);
    assert.equal(view.container.querySelector(".vn-reply-ready"), null);
    view.api.messages = [...view.api.messages, reply(16, 5)];
    view.api.pendingChoices = ["New current choice", "Wait"];
    view.api.isStreaming = false;
    await view.render();
    assert.ok(view.container.querySelector(".vn-reply-ready"));
    await view.click('[aria-label="Skip"]', 2);
    assert.match(view.position(), /Turn 16 \| Page 5 of 5/);
    assert.equal(view.text(), "Turn 16, passage 5.");
    assert.match(view.container.querySelector(".vn-choices")?.textContent ?? "", /New current choice/);
    assert.deepEqual(view.requests, ["send:Latest choice"]);
  } finally { await view.close(); }
});

test("Skip never reveals or accepts output behind a failed state guard", async () => {
  const view = await setup();
  try {
    view.api.messages = [...view.api.messages, { id: "pending-user", role: "user", content: "Already sent" }];
    view.api.error = "State update check failed (correction_timeout).";
    await view.render();
    const before = view.position();
    await view.click('[aria-label="Skip"]', 2);
    assert.equal(view.position(), before);
    assert.equal(view.container.querySelector(".vn-choices"), null);
    assert.match(view.container.querySelector(".vn-error")?.textContent ?? "", /State update check failed/);
    assert.deepEqual(view.requests, []);
  } finally { await view.close(); }
});
