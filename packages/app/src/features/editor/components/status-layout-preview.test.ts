import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("status preview hydrates immediately and reports asset failure without unmounting a recovering frame", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  const channels: Array<{ channel: string; data: unknown }> = [];
  let assetError = false, rendered = false;
  const noop = () => {};
  let input = { entryFile: "preview.tsx", files: {} };
  const pushChannel = (channel: string, data: unknown) => { channels.push({ channel, data }); };
  const mocks: Record<string, unknown> = {
    "@/features/sandbox/use-sandbox": { useSandbox: () => ({ rendered, assetError, installRoot: noop, pushChannel, iframeRefCallback: noop, sandboxUrl: "/sandbox/index.html" }) },
    "@/features/studio/lib/tsx-bundler": { bundleTSX: () => ({ code: "compiled preview", error: null }) },
    "../lib/status-visualizations": { buildStatusPreviewFiles: () => input },
  };
  const module = { exports: {} as { StatusLayoutPreview: ComponentType<Record<string, unknown>> } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./status-layout-preview.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const props = { root: {}, config: {}, variables: { hp: 84 }, templates: {}, worldName: "My card", category: "relationships", categoryRevision: 0 };
  const render = () => act(async () => root.render(createElement(module.exports.StatusLayoutPreview, props)));
  try {
    await render();
    assert.deepEqual(channels.find(item => item.channel === "messages")?.data, { messages: [] }, "both hydration channels must arrive without waiting for the sandbox fallback timer");
    assert.deepEqual(channels.find(item => item.channel === "variables")?.data, { variables: { hp: 84 }, globalVariables: {} });
    const frame = document.querySelector("iframe");
    assert.ok(frame);
    const selections: unknown[] = [];
    frame.contentWindow!.postMessage = (data: unknown) => { selections.push(data); };
    assert.ok(document.querySelector('[role="status"]'));
    assetError = true;
    await render();
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /font/i);
    assert.equal(document.querySelector("iframe"), frame);
    assert.equal(selections.length, 0, "wait for the preview to be ready before navigating it");
    rendered = true; assetError = false;
    await render();
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.equal(document.querySelector("iframe"), frame);
    assert.deepEqual(selections, [{ type: "yumina-status-preview-category", categoryId: "relationships" }]);
    props.variables = { hp: 37 };
    await render();
    assert.equal(selections.length, 1, "value updates must preserve navigation inside the preview");
    props.category = "empty-category";
    await render();
    assert.deepEqual(selections.at(-1), { type: "yumina-status-preview-category", categoryId: "empty-category" });
    props.categoryRevision++;
    await render();
    assert.equal(selections.length, 3, "clicking the selected builder category again must navigate back after manual preview navigation");
    const ready = (source: Window | null) => act(async () => {
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source, data: { type: "yumina-status-preview-ready" } }));
    });
    await ready(null);
    assert.equal(selections.length, 3, "ignore readiness from another window");
    input = { entryFile: "preview.tsx", files: { "status-config.ts": "updated" } };
    props.config = { title: "Updated status" };
    await render();
    const beforeReady = selections.length;
    await ready(frame.contentWindow);
    assert.equal(selections.length, beforeReady + 1, "resend after the replacement receiver mounts even when sandbox readiness is latched");
    assert.deepEqual(selections.at(-1), { type: "yumina-status-preview-category", categoryId: "empty-category" }, "receiver readiness uses the latest category");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
