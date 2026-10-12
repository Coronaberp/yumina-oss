import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));

test("VN checkpoint naming refreshes names, reuses gaps, cancels and retries without losing the draft", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const saved: string[] = [];
  let names = ["Checkpoint #1", "Checkpoint #3", "Chapter 1"], fail = false;
  let finishLoad: ((value: Array<{ name: string }>) => void) | undefined;
  let finishSave: (() => void) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Exercise SDK replies independently from the delayed state channel.
  const api: any = {
    sessionId: "checkpoint-test", variables: {}, entries: [], messages: [], checkpoints: [],
    greetingContent: "A quiet moment.", pendingChoices: [], isStreaming: false, readOnly: false,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (s: string) => s, resolveAssetUrl: (s: string) => s,
    loadCheckpoints: () => new Promise(resolve => { finishLoad = resolve; }),
    saveCheckpoint: async (name?: string) => {
      let number = 1;
      while (names.includes(`Checkpoint #${number}`)) number++;
      const savedName = name ?? `Checkpoint #${number}`;
      saved.push(savedName); if (fail) throw new Error("Save failed"); await new Promise<void>(resolve => { finishSave = resolve; }); names.push(savedName);
    },
  };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
    assert.ok(button, "Missing button " + label);
    await act(async () => button.click());
  };
  const field = () => container.querySelector<HTMLInputElement>("#vn-checkpoint-name")!;
  const fill = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field(), value); field().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  };
  const open = async () => {
    await click("Save");
    assert.equal(field().disabled, true);
    await act(async () => finishLoad!(names.map(name => ({ name }))));
  };
  try {
    await act(async () => root.render(createElement(result.Component!)));
    await click("Menu");
    await open();
    assert.equal(field().value, "Checkpoint #2", "fresh API reply takes precedence over a stale empty state channel");
    assert.equal(document.activeElement, field());
    assert.equal(field().selectionStart, 0);
    assert.equal(field().selectionEnd, field().value.length);
    assert.deepEqual(saved, []);
    await click("Cancel");
    assert.equal(document.activeElement, container.querySelector(".vn-menu-save"));
    await open();
    await act(async () => field().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.ok(container.querySelector('[aria-label="Story menu"]'));
    assert.deepEqual(saved, []);
    await open();
    await fill("  ");
    assert.equal(container.querySelector<HTMLButtonElement>('.vn-save button[type="submit"]')!.disabled, true);
    await fill("  Before the duel  ");
    fail = true;
    await click("Save");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Save failed/);
    assert.equal(field().value, "  Before the duel  ");
    fail = false;
    const form = container.querySelector<HTMLFormElement>(".vn-save form")!;
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(saved, ["Before the duel", "Before the duel"], "retry preserves the trimmed name; duplicate submission is ignored");
    await act(async () => field().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.ok(container.querySelector('.vn-save'), "pending saves cannot dismiss the modal");
    await act(async () => finishSave!());
    assert.equal(container.querySelector('.vn-save'), null);
    await open();
    assert.equal(field().value, "Checkpoint #2", "custom names do not reserve a numbered checkpoint");
    await click("Save");
    await act(async () => finishSave!());
    await open();
    assert.equal(field().value, "Checkpoint #4");
    await click("Cancel");
    names = names.filter(name => name !== "Checkpoint #1");
    await open();
    assert.equal(field().value, "Checkpoint #1", "deleted numbers are available again");
    await click("Cancel");
    api.readOnly = true;
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector<HTMLButtonElement>(".vn-menu-save")!.disabled, true);
    api.readOnly = false; api.isStreaming = true;
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector<HTMLButtonElement>(".vn-menu-save")!.disabled, true);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
