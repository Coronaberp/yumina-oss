import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ComponentType } from "react";
import type { Variable } from "@yumina/engine";
import { statusPreviewValues } from "../lib/status-preview-values";

const sourceUrl = new URL("./status-preview-values.tsx", import.meta.url);
const require = createRequire(sourceUrl);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");

test("preview explains the hidden relationship and applies score plus meeting flag only on explicit shortcut", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = require("react-dom/client");
  const module = { exports: {} as { StatusPreviewValues: ComponentType } };
  const helper = require(new URL("../lib/status-preview-values.ts", sourceUrl).pathname);
  const mocks: Record<string, unknown> = { "../lib/status-preview-values": helper, "@/components/ui/select": { Select: "select" } };
  new Function("require", "module", "exports", transform(readFileSync(sourceUrl, "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const variables = [{ id: "rel-blair", name: "Blair relationship", type: "number", defaultValue: 0,
    activation: { mode: "conditions", conditionLogic: "all", conditions: [{ variableId: "social-evidence.met.blair", operator: "eq", value: true }] },
  }, { id: "social-evidence", name: "Meetings", type: "json", defaultValue: { met: { blair: false, william: true }, events: ["keep"] } }] as Variable[];
  const original = JSON.stringify(variables);
  let overrides: Record<string, unknown> = {};
  const changes: Record<string, unknown>[] = [];
  const mounted = createRoot(document.getElementById("root"));
  const render = () => mounted.render(React.createElement(module.exports.StatusPreviewValues, {
    variables, values: statusPreviewValues(variables), overrides,
    onOverridesChange: (next: Record<string, unknown>) => { changes.push(next); overrides = next; render(); },
  }));
  const button = (name: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === name);
  const click = async (name: string) => React.act(async () => { const node = button(name); assert.ok(node, name); node.click(); });
  const type = async (text: string) => React.act(async () => {
    const input = document.querySelector('input[inputmode="decimal"]');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await React.act(async () => render());
    assert.match(document.body.textContent ?? "", /Blair hasn’t been met in this preview/);
    assert.doesNotMatch(document.body.textContent ?? "", /social-evidence\.met\.blair|\beq true\b/);
    assert.ok(button("Show in preview"), "explicit shortcut should explain and satisfy the met gate");
    await type("200"); await click("Use value");
    assert.deepEqual(overrides, { "rel-blair": 200 }, "plain Use value cannot silently change meetings");
    await click("Show in preview");
    assert.deepEqual(overrides, { "rel-blair": 200, "social-evidence": { met: { blair: true, william: true }, events: ["keep"] } });
    assert.equal(button("Show in preview"), undefined, "notice clears after the condition is satisfied");
    await click("Reset all values");
    assert.deepEqual(overrides, {});
    assert.ok(button("Show in preview"));
    await type("invalid"); const count = changes.length; await click("Show in preview");
    assert.equal(changes.length, count, "invalid score cannot partially apply the meeting flag");
    assert.match(document.querySelector('[role="alert"]')!.textContent ?? "", /finite number/);
    await click("Reset all values");
    const raw = document.querySelector('[aria-label="Advanced data for Meetings"]')!;
    assert.equal((raw.closest("details") as HTMLDetailsElement).open, false, "raw data belongs in collapsed Advanced");
    const meetingRow = raw.closest("details")!.parentElement!;
    const switchButton = document.querySelector('[role="switch"][aria-label="Blair met"]') as HTMLButtonElement;
    const beforeToggle = changes.length;
    await React.act(async () => switchButton.click());
    assert.equal(changes.length, beforeToggle, "form controls edit a local draft until Use value");
    await React.act(async () => [...meetingRow.querySelectorAll("button")].find(button => button.textContent === "Use value")!.click());
    assert.deepEqual(overrides, { "social-evidence": { met: { blair: true, william: true }, events: ["keep"] } });
    const currentRow = document.querySelector('[aria-label="Advanced data for Meetings"]')!.closest("details")!.parentElement!;
    await React.act(async () => {
      const area = currentRow.querySelector('[aria-label="Entry 1"]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, "x".repeat(65_536));
      area!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal([...currentRow.querySelectorAll("button")].find(button => button.textContent === "Use value")!.disabled, true, "oversized form edits cannot apply a stale accepted value");
    assert.match(document.querySelector('[role="alert"]')!.textContent ?? "", /too large/);
    assert.equal((currentRow.querySelector('[aria-label="Entry 1"]') as HTMLTextAreaElement).value, "keep", "rejected input visibly returns to the retained data");
    await React.act(async () => (currentRow.querySelector('[aria-label="Blair met"]') as HTMLButtonElement).click());
    await React.act(async () => [...currentRow.querySelectorAll("button")].find(button => button.textContent === "Use value")!.click());
    assert.deepEqual(overrides, { "social-evidence": { met: { blair: false, william: true }, events: ["keep"] } }, "a later accepted edit cannot retain an unapplied oversized draft");
    assert.equal(JSON.stringify(variables), original);
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
