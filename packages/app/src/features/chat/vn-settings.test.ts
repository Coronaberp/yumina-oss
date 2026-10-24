import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import type { VnTextPreferences } from "@yumina/shared";

test("token statistics default on, can be hidden, and survive reload and other settings changes", async () => {
  const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
  const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  let root = createRoot(container);
  // A pre-existing preference has no new key and must retain its old values.
  const stored = new Map([["vn:settings", JSON.stringify({ textSize: 23, autoDelay: 7000 })]]);
  let personal: VnTextPreferences = { dialogue: { font: "serif", color: "#aabbcc" }, narration: {} };
  const api = {
    sessionId: "settings-test", worldId: "world", worldName: "Academy", entries: [], variables: {},
    readOnly: true, isStreaming: false, messages: [{ id: "reply", role: "assistant", content: "The courtyard is quiet.", tokenCount: 1000, generationTimeMs: 1000 }],
    pendingChoices: [], storage: { get: async (key: string) => stored.get(key) ?? null, set: async (key: string, value: string) => { stored.set(key, value); } },
    renderMarkdown: (value: string) => value, resolveAssetUrl: (value: string) => value, getAudioVolume: () => 0.5,
    get vnTextPreferences() { return personal; },
    setVnTextPreferences: async (value: VnTextPreferences) => { personal = value; },
  };
  const compiled = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(compiled.error, null);
  const render = async () => { await act(async () => root.render(createElement(compiled.Component!))); };
  const click = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
    assert.ok(button, name); await act(async () => button.click());
  };
  const openSettings = async () => { await click("Menu"); await click("Settings"); };
  const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  try {
    await render(); await openSettings();
    assert.ok(checkbox(), "Show token statistics is a checkbox");
    assert.equal(checkbox().closest("label")?.textContent?.trim(), "Show token statistics");
    assert.equal(checkbox().checked, true);
    assert.equal(container.textContent?.includes("Story sessions"), false);
    assert.equal(container.textContent?.includes("Choose AI model"), true);
    await act(async () => checkbox().click());
    assert.deepEqual(JSON.parse(stored.get("vn:settings")!), { textSize: 23, autoDelay: 7000, showTokenStatistics: false });
    await click("Close menu");
    assert.equal(container.querySelector(".vn-reply-metrics"), null);
    assert.equal(container.querySelector(".vn-progress")?.textContent, "Turn 1 | Page 1 of 1");
    await act(async () => root.unmount()); root = createRoot(container);
    await render(); await openSettings();
    assert.equal(checkbox().checked, false, "Disabled preference survives remount");
    const size = container.querySelector<HTMLSelectElement>('select[aria-label="Messages size"]')!;
    await act(async () => { size.value = "32"; size.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(JSON.parse(stored.get("vn:settings")!).showTokenStatistics, false, "Other settings preserve the preference");
    await act(async () => checkbox().click());
    await click("Close menu");
    assert.ok(container.querySelector(".vn-reply-metrics"));
    assert.equal(personal.dialogue.size, 32);
    assert.equal(personal.dialogue.font, "serif");
    assert.equal(personal.dialogue.color, "#aabbcc");
    assert.equal(JSON.parse(stored.get("vn:settings")!).autoDelay, 7000);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
