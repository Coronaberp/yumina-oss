import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const folder = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = () => Object.fromEntries(readdirSync(folder).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, folder), "utf8")]));

async function setup(pace = 4500, content = "*" + "a".repeat(100) + "*\n\n*Second passage.*\n\n*Last passage.*") {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  let serial = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  // The real reader schedules timeouts; advancing this deterministic clock avoids wall-clock sleeps.
  globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = ++serial; timers.set(id, { callback, delay }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(Number(id)); }) as unknown as typeof clearTimeout;
  const writes: string[] = [], generated: string[] = [];
  const api: any = {
    sessionId: "auto-test", worldId: "world", worldName: "Auto test", variables: {}, entries: [], user: { name: "QA" },
    messages: [{ id: "reply", role: "assistant", status: "complete", content }], pendingChoices: ["Wait"], isStreaming: false, error: null,
    storage: { get: async (key: string) => key === "vn:settings" ? JSON.stringify({ textSize: 27, autoDelay: pace, showTokenStatistics: false }) : null,
      set: async (key: string, value: string) => { writes.push(key + ":" + value); } },
    renderMarkdown: (text: string) => text, resolveAssetUrl: (ref: string) => ref,
    sendMessage: () => generated.push("send"), continueLastMessage: () => generated.push("continue"),
  };
  const result = bundleAndCompile({ files: files(), entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  const click = async (name: string, count = 1) => { const button = container.querySelector<HTMLElement>(`[aria-label="${name}"]`); assert.ok(button, name); await act(async () => { for (let i = 0; i < count; i++) button.click(); }); };
  const scheduled = () => [...timers.values()].filter(timer => timer.delay > 500);
  const fire = async () => { const entry = [...timers.entries()].find(([, timer]) => timer.delay > 500); assert.ok(entry, "Auto timeout is scheduled"); timers.delete(entry[0]); await act(async () => entry[1].callback()); };
  await render();
  return { api, container, dom, timers, writes, generated, render, click, scheduled, fire,
    position: () => container.querySelector(".vn-progress-summary")?.textContent ?? "",
    close: async () => { await act(async () => root.unmount()); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; dom.window.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test("Auto responds to all stored paces on short and long visible pages", async () => {
  const expected = new Map([[2500, [1214, 2500]], [4500, [2186, 4500]], [7000, [3400, 7000]]]);
  for (const [pace, delays] of expected) for (const [i, length] of [100, 280].entries()) {
    const view = await setup(pace, "*" + "a".repeat(length) + "*\n\n*End.*");
    try { await view.click("Auto"); assert.equal(view.scheduled()[0]?.delay, delays[i]); assert.equal(view.generated.length, 0); }
    finally { await view.close(); }
  }
});

test("Auto reads each overflowing screenful before advancing the passage", async () => {
  const view = await setup();
  try {
    const passage = view.container.querySelector<HTMLElement>(".vn-text")!;
    Object.defineProperties(passage, { scrollHeight: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 100 } });
    passage.scrollBy = (options?: ScrollToOptions | number) => { passage.scrollTop = Math.min(300, passage.scrollTop + ((options as ScrollToOptions).top ?? 0)); };
    await view.click("Auto");
    assert.ok(view.scheduled()[0]!.delay < 2186, "Only the visible screenful contributes to this delay");
    await view.fire();
    assert.match(view.position(), /Page 1 of 3/); assert.ok(passage.scrollTop > 0); assert.equal(view.scheduled().length, 1);
    while (passage.scrollTop < 300) await view.fire();
    assert.match(view.position(), /Page 1 of 3/);
    await view.fire(); assert.match(view.position(), /Page 2 of 3/); assert.equal(passage.scrollTop, 0);
    assert.deepEqual(view.generated, []);
  } finally { await view.close(); }
});

test("Auto cancels stale timers for toggles, manual reading and generation errors", async () => {
  const view = await setup();
  try {
    await view.click("Auto", 2); assert.equal(view.scheduled().length, 0, "Two batched toggles return Auto to off");
    await view.click("Auto"); await view.click("Advance story"); assert.match(view.position(), /Page 2 of 3/); assert.equal(view.scheduled().length, 0);
    await view.click("Auto"); view.api.error = "Provider failed"; await view.render(); assert.equal(view.scheduled().length, 0);
    view.api.error = null; await view.render(); assert.equal(view.scheduled().length, 0, "Recovery does not silently re-enable Auto");
    await view.click("Auto"); view.api.isStreaming = true; await view.render(); assert.equal(view.scheduled().length, 0);
    view.api.isStreaming = false; await view.render(); assert.equal(view.scheduled().length, 0);
    assert.deepEqual(view.generated, []);
  } finally { await view.close(); }
});

test("Auto pauses in menus, stops for manual overflow scrolling and hidden documents", async () => {
  const view = await setup();
  try {
    await view.click("Auto"); await view.click("Menu"); assert.equal(view.scheduled().length, 0);
    await view.click("Close menu"); assert.equal(view.scheduled().length, 1, "Resume gets a fresh reading delay");
    const passage = view.container.querySelector<HTMLElement>(".vn-text")!;
    Object.defineProperties(passage, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } });
    await act(async () => passage.dispatchEvent(new view.dom.window.WheelEvent("wheel", { deltaY: 10, bubbles: true, cancelable: true })));
    assert.equal(view.scheduled().length, 0, "Native overflow scroll also interrupts Auto");
    await view.click("Auto"); Object.defineProperty(view.dom.window.document, "hidden", { configurable: true, value: true });
    await act(async () => view.dom.window.document.dispatchEvent(new view.dom.window.Event("visibilitychange")));
    assert.equal(view.scheduled().length, 0);
  } finally { await view.close(); }
});

test("Auto reaches choices without submitting or generating and preserves pace preference", async () => {
  const view = await setup(7000);
  try {
    await view.click("Auto"); await view.fire(); await view.fire();
    assert.match(view.position(), /Page 3 of 3/); assert.equal(view.scheduled().length, 0);
    assert.equal(view.container.querySelector('[aria-label="Auto"]')?.getAttribute("aria-pressed"), "false");
    assert.deepEqual(view.generated, []);
    assert.ok(view.writes.every(write => !write.startsWith("vn:settings:")), "Auto does not rewrite the saved pace");
  } finally { await view.close(); }
});


test("Auto ignores unrelated SDK updates and rejects an obsolete callback after navigation", async () => {
  const view = await setup();
  try {
    await view.click("Auto");
    const old = view.scheduled()[0]!;
    view.api.streamingTokenCount = 500; await view.render();
    assert.equal(view.scheduled()[0], old, "An unrelated SDK rerender keeps the existing deadline");
    await view.click("Advance story");
    assert.match(view.position(), /Page 2 of 3/);
    await act(async () => old.callback());
    assert.match(view.position(), /Page 2 of 3/, "An already-queued obsolete timer cannot double-advance");
    assert.deepEqual(view.generated, []);
  } finally { await view.close(); }
});

test("Auto advances a submitted action's pages without opening its reply early", async () => {
  const view = await setup(4500, "*Ready.*");
  try {
    const choice = "*I check the door.*\n\n*I wait for a reply.*";
    view.api.pendingChoices = [choice];
    view.api.classifyPlayerExpression = async () => "normal";
    view.api.sendMessage = () => { view.generated.push("send"); view.api.messages.push({ id: "user", role: "user", content: choice }); view.api.isStreaming = true; };
    await view.render();
    await act(async () => (view.container.querySelector(".vn-choice:not(.vn-custom-choice)") as HTMLButtonElement).click());
    view.api.isStreaming = false;
    view.api.messages.push({ id: "next-reply", role: "assistant", status: "complete", content: "*Accepted reply.*" });
    await view.render();
    assert.match(view.position(), /Page 1 of 2/);
    await view.click("Auto"); await view.fire();
    assert.match(view.position(), /Page 2 of 2/);
    assert.equal(view.container.querySelector(".vn-text")?.textContent, "I wait for a reply.");
    assert.match(view.container.querySelector(".vn-reply-ready")?.textContent ?? "", /Reply ready/);
    assert.equal(view.scheduled().length, 0); assert.deepEqual(view.generated, ["send"]);
  } finally { await view.close(); }
});
