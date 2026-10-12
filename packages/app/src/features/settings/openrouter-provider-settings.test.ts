import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ApiKeyMetadata } from "@yumina/shared";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location,
  localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)), "@yumina/engine": fileURLToPath(new URL("../../../../engine/src/index.ts", import.meta.url)), "@yumina/shared": fileURLToPath(new URL("../../../../shared/src/index.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true } });
const { ApiKeysSettings } = await vite.ssrLoadModule("/src/features/settings/api-keys.tsx") as typeof import("./api-keys");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { profile: JSON.parse(readFileSync(new URL("../../locales/en/profile.json", import.meta.url), "utf8")) } }, interpolation: { escapeValue: false } });
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await vite.close(); dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
function button(text: string) {
  const node = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === text || (text === "Save" && node.textContent?.trim() === "Saved"));
  assert.ok(node, `Missing button: ${text}`); return node;
}
const checkbox = (label: string) => document.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${label}"]`);
const settleDiscovery = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 420)); });
async function input(field: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
async function render(run: (entry: { metadata: ApiKeyMetadata }, patches: Record<string, unknown>[], remount: () => Promise<void>) => Promise<void>, discoveryError = false) {
  const entry = { id: "or-profile", provider: "openrouter", label: "OpenRouter profile", baseUrl: null,
    metadata: { defaultModel: "deepseek/deepseek-v3.2", models: ["deepseek/deepseek-v3.2", "google/gemini-2.5-pro"] } as ApiKeyMetadata, createdAt: "2026-10-11" };
  const patches: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("/openrouter-providers?")) {
      if (discoveryError) return Response.json({ error: "OpenRouter provider list unavailable (503)" }, { status: 502 });
      const model = new URL(path, "http://localhost").searchParams.get("model");
      return Response.json({ data: { providers: model?.startsWith("google/")
        ? [{ slug: "google-vertex/us-east5", name: "Google Vertex" }]
        : [{ slug: "cohere", name: "Cohere" }, { slug: "deepinfra/turbo", name: "DeepInfra" }] } });
    }
    if (path.endsWith("/content-endpoints")) return Response.json({ data: { sfwApiKeyId: entry.id, nsfwApiKeyId: null } });
    if (path.endsWith(`/api/keys/${entry.id}`) && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)); patches.push(patch); Object.assign(entry.metadata, patch); return Response.json({ data: entry });
    }
    if (path.endsWith("/api/keys")) return Response.json({ data: [entry] });
    return Response.json({ data: { id: "owner", preferences: {} } });
  };
  const root = createRoot(document.getElementById("root")!); let key = 0;
  const remount = async () => {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ApiKeysSettings, { key: key++ }))));
    await act(async () => button("Edit profile").click());
    await settleDiscovery();
  };
  try { await remount(); await run(entry, patches, remount); }
  finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; }
}

test("OpenRouter profile saves multiple allowed providers per model and restores them on reload", async () => {
  await render(async (entry, patches, remount) => {
    assert.ok(checkbox("Cohere (cohere)"), "OpenRouter provider choices are available below the model");
    await act(async () => checkbox("Cohere (cohere)")!.click());
    await act(async () => checkbox("DeepInfra (deepinfra/turbo)")!.click());
    await act(async () => button("Save").click());
    assert.deepEqual(patches.at(-1)?.openRouterProviders, { "deepseek/deepseek-v3.2": ["cohere", "deepinfra/turbo"] });
    await remount();
    assert.equal(checkbox("Cohere (cohere)")?.getAttribute("aria-checked"), "true");
    const modelField = document.querySelector<HTMLInputElement>('input[placeholder="auto-filled when you pick a model above"]')!;
    assert.ok(modelField);
    await input(modelField, "google/gemini-2.5-pro"); await settleDiscovery();
    assert.equal(checkbox("Cohere (cohere)"), null, "previous model choices are not shown for another model");
    await act(async () => checkbox("Google Vertex (google-vertex/us-east5)")!.click());
    await act(async () => button("Save").click());
    assert.deepEqual(entry.metadata.openRouterProviders, {
      "deepseek/deepseek-v3.2": ["cohere", "deepinfra/turbo"], "google/gemini-2.5-pro": ["google-vertex/us-east5"],
    });
    await act(async () => button("Use account defaults").click());
    await act(async () => button("Save").click());
    assert.deepEqual(entry.metadata.openRouterProviders, { "deepseek/deepseek-v3.2": ["cohere", "deepinfra/turbo"] });
  });
});

test("provider discovery errors are visible with a retry control", async () => {
  await render(async () => {
    assert.ok(document.body.textContent?.includes("OpenRouter provider list unavailable (503)"));
    assert.ok(button("Retry"));
  }, true);
});
