import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { initialStatusConfig, writeStatusConfig } from "../editor/lib/status-visualizations";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));

test("Status replaces the menu sheet, displays confirmed live values, and Back restores focused menu", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const api = {
    sessionId: "status-test", variables: { hp: 84, relationship: 0 }, entries: [], messages: [], checkpoints: [], worldName: "Academy",
    greetingContent: "A quiet moment.", pendingChoices: [], isStreaming: false, readOnly: false,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (s: string) => s, resolveAssetUrl: (s: string) => s,
  };
  const config = initialStatusConfig([{ id: "hp", name: "Health", type: "number", defaultValue: 100, max: 100 },
    { id: "relationship", name: "Affection", type: "number", defaultValue: 0, min: -100, max: 100 }]);
  const result = bundleAndCompile({ files: { ...files, "status-config.ts": writeStatusConfig(config) }, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => act(async () => root.render(createElement(result.Component!)));
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
    assert.ok(button, "Missing button " + label);
    await act(async () => button.click());
  };
  try {
    await render(); await click("Menu"); await click("Status");
    assert.equal(container.querySelector('[aria-label="Story menu"]'), null);
    assert.equal(container.querySelectorAll(".vn-drawer").length, 1);
    assert.ok(container.querySelector('[aria-label="Player status"]'));
    assert.equal(document.activeElement, container.querySelector(".vn-back"));
    await click("Vitals");
    assert.match(container.querySelector(".vn-status-meter")!.textContent!, /84 \/ 100/);
    assert.equal(container.querySelector('[aria-label="Story controls"]'), null);
    api.isStreaming = true; api.variables = { hp: 13, relationship: 0 }; await render();
    assert.match(container.querySelector(".vn-status-meter")!.textContent!, /84 \/ 100/);
    api.isStreaming = false; await render();
    assert.match(container.querySelector(".vn-status-meter")!.textContent!, /13 \/ 100/);
    await click("Relationships");
    assert.equal(container.querySelectorAll(".vn-status-pips-meter i").length, 10);
    assert.equal(container.querySelectorAll('.vn-status-pips-meter i[data-filled="true"]').length, 0);
    assert.equal(container.querySelector(".vn-status-pips-center"), null);
    for (const value of [-60, -40, 0, 40]) {
      api.variables = { hp: 13, relationship: value }; await render();
      assert.equal(container.querySelectorAll('.vn-status-pips-meter i[data-filled="true"]').length, Math.abs(value) / 10);
      assert.equal(container.querySelector(".vn-status-pips-meter")!.getAttribute("data-negative"), String(value < 0));
    }
    const tabs = container.querySelector<HTMLElement>('.vn-status-tabs')!;
    Object.defineProperty(tabs, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(tabs, 'scrollWidth', { configurable: true, value: 300 });
    const scrollTabs = async (left: number) => act(async () => {
      tabs.scrollLeft = left;
      tabs.dispatchEvent(new dom.window.Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const edgeOpacity = () => [...container.querySelectorAll<HTMLElement>('.vn-status-edge')].map(edge => edge.style.opacity);
    await scrollTabs(0); assert.deepEqual(edgeOpacity(), ['0', '1']);
    await scrollTabs(100); assert.deepEqual(edgeOpacity(), ['1', '1']);
    await scrollTabs(200); assert.deepEqual(edgeOpacity(), ['1', '0']);
    Object.defineProperty(tabs, 'scrollWidth', { configurable: true, value: 100 });
    await scrollTabs(0); assert.deepEqual(edgeOpacity(), ['0', '0']);
    await click("Back");
    assert.ok(container.querySelector('[aria-label="Story menu"]'));
    assert.equal(container.querySelector('[aria-label="Player status"]'), null);
    assert.equal(document.activeElement, container.querySelector(".vn-menu-status"));
    await click("Status");
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.ok(container.querySelector('[aria-label="Story menu"]'));
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
