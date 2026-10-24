import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ComponentType } from "react";

const sourceUrl = new URL("./status-preview-json.tsx", import.meta.url);
const require = createRequire(sourceUrl);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");

test("all JSON types are editable as form controls, including meetings, empty groups/lists and null", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = require("react-dom/client");
  const module = { exports: {} as { StatusPreviewJsonEditor: ComponentType } };
  new Function("require", "module", "exports", transform(readFileSync(sourceUrl, "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => require(id), module, module.exports);
  let value: unknown = { met: { "blair-winters": false }, title: "", count: 0, events: [], extra: {}, optional: null };
  const original = JSON.stringify(value);
  let invalid = "";
  const mounted = createRoot(document.getElementById("root"));
  const render = () => mounted.render(React.createElement(module.exports.StatusPreviewJsonEditor, {
    value, label: "Evidence", onChange: (next: unknown) => { value = next; render(); }, onErrorChange: (next: string) => { invalid = next; },
  }));
  const named = (tag: string, name: string) => [...document.querySelectorAll(tag)].find(node => node.getAttribute("aria-label") === name) as HTMLInputElement;
  const input = async (node: HTMLInputElement, text: string) => React.act(async () => {
    assert.ok(node); const prototype = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, text);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  const click = async (name: string) => React.act(async () => { const node = named("button", name); assert.ok(node, name); node.click(); });
  try {
    await React.act(async () => render());
    assert.equal(document.querySelectorAll('textarea[spellcheck="false"]').length, 0, "no raw JSON required in the form");
    await click("Blair Winters met");
    assert.equal((value as { met: Record<string, boolean> }).met["blair-winters"], true);
    await input(named("textarea", "Title"), "Dossier\nField notes");
    assert.equal((value as { title: string }).title, "Dossier\nField notes");
    await input(named("input", "Count"), "-12.5");
    assert.equal((value as { count: number }).count, -12.5);
    await input(named("input", "Count"), "Infinity"); assert.ok(invalid);
    await input(named("input", "Count"), "0"); assert.equal(invalid, "");
    await click("Add entry to Recorded events");
    await input(named("textarea", "Entry 1"), "Met Blair");
    await click("Remove Entry 1");
    assert.deepEqual((value as { events: unknown[] }).events, []);
    await input(named("input", "New field in Extra"), "literal.key");
    await click("Add field to Extra");
    assert.equal((value as { extra: Record<string, unknown> }).extra["literal.key"], "");
    await input(named("select", "Value type for Optional"), "boolean");
    assert.equal((value as { optional: boolean }).optional, false);
    assert.ok(JSON.parse(original).met["blair-winters"] === false);
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
