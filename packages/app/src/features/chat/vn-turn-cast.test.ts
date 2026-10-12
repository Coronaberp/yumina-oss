import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

test("VN cast belongs to the viewed turn and purges absent characters immediately", async () => {
  const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
  const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const names = ["Lupe", "Maeve", "Kei"];
  const messages = [{ id: "one", role: "assistant", content: '[SPEAKER:Lupe:normal] "Hello."\n[SPEAKER:Maeve:happy] "Welcome."\n[SPEAKER:Narrator:normal] **They wait.**' }];
  const api = {
    sessionId: "turn-cast", worldId: "world", worldName: "Academy", entries: names.map(name => ({ name, role: "character", enabled: true })),
    messages, variables: { "vn-sprites": Object.fromEntries(names.map(name => [name, { normal: `/${name}.png`, happy: `/${name}-happy.png` }])) },
    pendingChoices: [], isStreaming: false, readOnly: false,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (text: string) => text, resolveAssetUrl: (ref: string) => ref,
  };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  const cast = () => Array.from(container.querySelectorAll<HTMLImageElement>(".vn-sprite")).map(image => image.dataset.character);
  const advance = async () => { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Advance story"]')!.click()); };
  const back = async () => { await act(async () => container.querySelector(".vn")!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }))); };
  try {
    await render();
    assert.deepEqual(cast(), ["Lupe"], "unread future speakers stay hidden");
    await advance();
    assert.deepEqual(cast(), ["Lupe", "Maeve"]);
    await advance();
    assert.deepEqual(cast(), ["Lupe", "Maeve"], "narration retains the current turn's cast");
    messages.push({ id: "two", role: "assistant", content: '[SPEAKER:Maeve:normal] "I am alone now."' });
    await render();
    assert.deepEqual(cast(), ["Maeve"], "a character absent from the new turn is immediately removed, including exit nodes");
    assert.equal(container.querySelector('[data-exiting="true"]'), null);
    await back();
    assert.deepEqual(cast(), ["Lupe", "Maeve"], "browsing history restores that turn's cast");
    await advance();
    assert.deepEqual(cast(), ["Maeve"], "returning forward removes historical characters again");
    messages.push({ id: "three", role: "assistant", content: '[SPEAKER:Narrator:normal] **The room is empty.**' });
    await render();
    assert.deepEqual(cast(), [], "a narration-only turn purges the previous cast");
    messages.push({ id: "four", role: "assistant", content: '[SPEAKER:Kei:normal] "A new visitor."' });
    await render();
    assert.deepEqual(cast(), ["Kei"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
