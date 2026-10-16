import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const folder = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(folder).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(new URL(name, folder), "utf8")]));

test("tapping reveals the hidden passage before advancing and starts each page at the top", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let generated = 0;
  const content = "*A long first passage.*\n\n*A long second passage.*\n\n*The last passage.*";
  const api = {
    sessionId: "reading-test", worldId: "world", worldName: "Academy", variables: {}, entries: [],
    messages: [{ id: "reply", role: "assistant", content }], pendingChoices: [], isStreaming: false,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (text: string) => text, resolveAssetUrl: (ref: string) => ref,
    sendMessage: () => generated++, continueLastMessage: () => generated++,
  };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const click = async (selector: string) => act(async () => (container.querySelector(selector) as HTMLElement).click());
  try {
    await act(async () => root.render(createElement(result.Component!)));
    const text = container.querySelector<HTMLElement>(".vn-text")!;
    Object.defineProperties(text, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { configurable: true, value: 200 } });
    const scrolls: ScrollToOptions[] = [];
    text.scrollBy = (options?: ScrollToOptions | number) => {
      assert.equal(typeof options, "object");
      scrolls.push(options as ScrollToOptions);
      text.scrollTop = Math.min(300, text.scrollTop + ((options as ScrollToOptions).top ?? 0));
    };
    await click(".vn-stage");
    assert.ok(text.scrollTop > 0, "A stage tap scrolls the unread passage");
    assert.match(container.querySelector(".vn-progress")!.textContent!, /Page 1 of 3/);
    assert.ok(text.scrollTop < 200, "Keep overlap so the next screenful retains reading context");
    await click(".vn-text");
    assert.equal(text.scrollTop, 300);
    assert.match(container.querySelector(".vn-progress")!.textContent!, /Page 1 of 3/, "Reaching the bottom does not also skip ahead");
    assert.equal(scrolls[0]!.behavior, "instant", "Reduced-motion readers scroll without animation");
    await click(".vn-stage");
    assert.match(container.querySelector(".vn-progress")!.textContent!, /Page 2 of 3/);
    assert.equal(container.querySelector<HTMLElement>(".vn-text")!.scrollTop, 0, "The next passage opens at its beginning");
    Object.defineProperty(container.querySelector(".vn-text"), "scrollHeight", { configurable: true, value: 200 });
    await click(".vn-stage");
    assert.match(container.querySelector(".vn-progress")!.textContent!, /Page 3 of 3/, "A fully visible passage advances normally");
    await click(".vn-stage");
    assert.equal(generated, 0, "Reading taps never generate or continue the story");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
