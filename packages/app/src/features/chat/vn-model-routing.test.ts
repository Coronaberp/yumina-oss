import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

test("VN settings separates the next selection from the viewed reply and never invents legacy reasons", async () => {
  const folder = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
  const files = Object.fromEntries(readdirSync(folder).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(folder + name, "utf8")]));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client"); const container = dom.window.document.getElementById("root")!; const root = createRoot(container);
  const selected = "custom/accounts/fixture/models/deepseek-flash-1017", used = "custom/accounts/fixture/models/deepseek-flash";
  const api: any = { sessionId: "routing-ui", worldId: "world", worldName: "Academy", entries: [], variables: {}, readOnly: true, isStreaming: false,
    selectedModel: selected, messages: [{ id: "reply", role: "assistant", content: "The courtyard is quiet.", model: used, activeSwipeIndex: 0,
      swipes: [{ content: "The courtyard is quiet.", model: used, modelRouting: { requestedModel: selected, routedModel: used, reason: "content-fallback" } }] }],
    pendingChoices: [], storage: { get: async () => JSON.stringify({ showTokenStatistics: false }), set: async () => {} },
    renderMarkdown: (v: string) => v, resolveAssetUrl: (v: string) => v, getAudioVolume: () => .5 };
  const compiled = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api); assert.equal(compiled.error, null);
  const render = () => act(async () => root.render(createElement(compiled.Component!)));
  const click = async (label: string) => { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label); assert.ok(button, label); await act(async () => button.click()); };
  const details = () => container.querySelector('[aria-label="Model routing details"]')!;
  try {
    await render(); await click("Menu"); await click("Settings");
    assert.ok(details(), "model details are available inside settings");
    assert.match(details().textContent!, /Selected for next reply/); assert.match(details().textContent!, /deepseek-flash-1017/);
    assert.match(details().textContent!, /Reply model/); assert.match(details().textContent!, /Content routing used your configured fallback/);
    assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false, "the token-stat preference is untouched");
    const chosen = { content: "An alternate reply.", model: "custom/alternate-recorded", modelRouting: { requestedModel: "custom/alternate-selection", routedModel: "custom/alternate-recorded", reason: "content-check-uncertain" } };
    api.messages = [{ ...api.messages[0], activeSwipeIndex: 1, swipes: [api.messages[0].swipes[0], chosen] }]; await render();
    assert.match(details().textContent!, /alternate-recorded/); assert.match(details().textContent!, /Content checking was uncertain/);
    assert.doesNotMatch(details().textContent!, /Content routing used your configured fallback/);
    api.messages = [{ id: "reply", role: "assistant", content: "Legacy reply.", model: "custom/legacy-recorded" }]; await render();
    assert.match(details().textContent!, /legacy-recorded/); assert.doesNotMatch(details().textContent!, /fallback|uncertain|alternate/);
    api.messages = [{ id: "reply", role: "assistant", content: "Legacy unknown." }]; await render();
    assert.match(details().textContent!, /Not recorded/); assert.doesNotMatch(details().textContent!, /fallback|uncertain/);
    api.messages = [{ id: "reply", role: "assistant", content: "Versioned legacy.", model: "custom/other-swipe-model", activeSwipeIndex: 1, swipes: [{ content: "Original", model: "custom/other-swipe-model" }, { content: "Unknown version" }] }]; await render();
    assert.match(details().textContent!, /Not recorded/); assert.doesNotMatch(details().textContent!, /other-swipe-model/);
    api.messages = [{ ...api.messages[0], activeSwipeIndex: 8 }]; await render();
    assert.match(details().textContent!, /Not recorded/); assert.doesNotMatch(details().textContent!, /other-swipe-model/);
    await click("Close menu"); assert.equal(details(), null, "no extra badge or model label crowds the story stage");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
