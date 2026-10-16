import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

test("themed Turn picker supports selection, arrow navigation and Escape without a native select", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const files = { "turn-picker.tsx": readFileSync(new URL("../../../../../interfaces/vn/turn-picker.tsx", import.meta.url), "utf8"), "index.tsx": 'import { TurnPicker } from "./turn-picker"; export default function Test(){const [value,setValue]=React.useState("");return <TurnPicker value={value} onChange={setValue} replies={[{id:"one"},{id:"two"}]} currentTurnId="two" pending={false}/>;}' };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" });
  assert.equal(result.error, null);
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(result.Component!)));
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("select").length, 0);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
    await act(async () => trigger.click());
    assert.equal(document.querySelectorAll('[role="option"]').length, 3);
    const option = document.querySelectorAll<HTMLButtonElement>('[role="option"]')[2];
    await act(async () => option.click());
    assert.ok(trigger.textContent?.includes("Turn 2 (current)"));
    assert.equal(document.querySelector('[role="listbox"]'), null);
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.ok(document.querySelector('[role="listbox"]'));
    await act(async () => document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
