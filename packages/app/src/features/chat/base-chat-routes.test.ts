import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("base Chat layouts open Routes from inside the greeting and hide it after departure", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let opened = 0;
  const greeting = { role: "assistant", swipes: [{ content: "One" }, { content: "Two" }], model: null as string | null };
  const api = { sessionId: "play", personaSelectable: true, readOnly: false, isStreaming: false, hasEarlierMessages: false,
    language: "en", messages: [greeting], variables: {}, openStoryRoutes: () => { opened++; } };
  const require = createRequire(import.meta.url);
  const cache = new Map<string, { exports: Record<string, ComponentType<Record<string, unknown>>> }>();
  function load(file: string): Record<string, ComponentType<Record<string, unknown>>> {
    if (cache.has(file)) return cache.get(file)!.exports;
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> }; cache.set(file, module);
    const mocks: Record<string, unknown> = {
      "../sandbox-context": { useYumina: () => api },
      "../chat/message-list": { MessageList: () => createElement("div", { "data-messages": "" }, "Greeting content") },
      "./message-list": { MessageList: () => createElement("div", { "data-messages": "" }, "Greeting content") },
      "../chat/message-input": { MessageInput: () => createElement("textarea") },
      "./message-input": { MessageInput: () => createElement("textarea") },
      "../chat/markdown": { renderMessage: (text: string) => text },
    };
    new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), {
      transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic",
    }).code)((id: string) => {
      if (id in mocks) return mocks[id];
      if (id.startsWith(".")) {
        const local = resolve(dirname(file), id);
        const target = [local, local + ".tsx", local + ".ts"].find(path => existsSync(path));
        if (target) return load(target);
      }
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const variants = [
    load(new URL("../../../sandbox/building-blocks/chat.tsx", import.meta.url).pathname).Chat!,
    load(new URL("../../../sandbox/chat/chat-canvas.tsx", import.meta.url).pathname).ChatCanvas!,
  ];
  try {
    for (const Component of variants) {
      const render = () => root.render(createElement(Component));
      Object.assign(api, { messages: [greeting], personaSelectable: true, readOnly: false, isStreaming: false, hasEarlierMessages: false });
      await act(async () => render());
      const button = () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Open routes"]');
      assert.ok(button(), "Routes belongs to the base Chat rather than a host overlay");
      assert.ok(button()!.compareDocumentPosition(dom.window.document.querySelector('[data-messages]')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
      const before = opened;
      await act(async () => button()!.click());
      assert.equal(opened, before + 1);
      for (const changes of [
        { isStreaming: true }, { hasEarlierMessages: true }, { readOnly: true }, { personaSelectable: false },
        { messages: [greeting, { ...greeting, role: "user" }] }, { messages: [{ ...greeting, model: "generated" }] }, { messages: [] },
      ]) {
        Object.assign(api, { messages: [greeting], personaSelectable: true, readOnly: false, isStreaming: false, hasEarlierMessages: false }, changes);
        await act(async () => render());
        assert.equal(button(), null, JSON.stringify(changes));
      }
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
