import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ComponentType } from "react";
import type { StatusLayoutPreview } from "./status-layout-preview";

type PreviewProps = Parameters<typeof StatusLayoutPreview>[0];

const sourceUrl = new URL("./status-design-import.tsx", import.meta.url);
const require = createRequire(sourceUrl);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
const code = 'export default function StatusLayout({config,variables}){return <p>{variables.hp}</p>}';

async function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = require("react-dom/client");
  const rootFixture = { id: "root-a", name: "VN", interfaceId: "vn", entryFile: "index.tsx", updatedAt: "saved", compiled: { code: "old cached bundle", filesHash: "old", compilerVersion: 1 }, files: {
    "index.tsx": "authored menu", "status-sheet.tsx": 'import StatusLayout from "./status-layout";', "status-layout.tsx": "old design", "status-config.ts": "original config", "sprites.ts": "custom artwork",
  } };
  const mutations: unknown[] = [];
  const state = { serverWorldId: "world-a", worldDraft: { rootComponent: rootFixture }, readOnlyInspect: false, guestMode: false, editingLocked: false,
    updateRootComponent: (updates: unknown) => { mutations.push(updates); },
  };
  let owner = "owner-a", pending = false, preview: PreviewProps;
  const store = Object.assign((selector: (current: typeof state) => unknown) => selector(state), { getState: () => state });
  function Preview(props: PreviewProps) { preview = props; return React.createElement("div", { "data-test-preview": "true" }); }
  const helper = require(new URL("../lib/status-design-import.ts", sourceUrl).pathname);
  const mocks: Record<string, unknown> = {
    "@/lib/auth-client": { useSession: () => ({ data: owner ? { user: { id: owner } } : null, isPending: pending }) },
    "@/stores/editor": { useEditorStore: store },
    "./status-layout-preview": { StatusLayoutPreview: Preview },
    "../lib/status-design-import": helper,
  };
  const module = { exports: {} as { StatusDesignImport: ComponentType } };
  new Function("require", "module", "exports", transform(readFileSync(sourceUrl, "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const mounted = createRoot(document.getElementById("root"));
  const props = { root: rootFixture, variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 100 }], config: { title: "Status", subtitle: "", accent: "#c8b17e", groups: [{ id: "overview", label: "Overview" }], fields: [] }, templates: {}, worldName: "My VN", previewValues: { hp: 100 }, category: "overview", disabled: false };
  const render = async () => React.act(async () => mounted.render(React.createElement(module.exports.StatusDesignImport, props)));
  const button = (name: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === name) as HTMLButtonElement | undefined;
  const click = async (name: string) => React.act(async () => { const node = button(name); assert.ok(node, `button ${name}`); node.click(); });
  const paste = async (value: string) => React.act(async () => {
    const area = document.querySelector('[aria-label="Paste Status design"]') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const validate = async (ready: boolean, error = "") => React.act(async () => preview.onValidationChange!({ ready, error }));
  const prepare = async () => { await paste(code); await click("Check and preview design"); assert.ok(preview); };
  const cleanup = async () => {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  };
  await render();
  return { state, props, rootFixture, mutations, render, click, button, paste, prepare, validate, cleanup, dom, getPreview: () => preview,
    setOwner: (id: string) => { owner = id; }, setPending: (value: boolean) => { pending = value; } };
}

test("import preview/cancel and failed runtime never call the draft mutator", async () => {
  const h = await setup();
  try {
    const original = JSON.stringify(h.rootFixture);
    await h.prepare();
    assert.equal(h.getPreview().root.compiled, undefined, "old compiled cache must not enter candidate preview");
    assert.equal(h.button("Apply design")!.disabled, true, "loading cannot apply");
    await h.validate(false, "runtime failure");
    assert.equal(h.button("Apply design")!.disabled, true);
    await h.click("Apply design");
    assert.deepEqual(h.mutations, []);
    await h.click("Cancel preview");
    assert.equal(document.querySelector('[data-test-preview]'), null);
    assert.deepEqual(h.mutations, []);
    assert.equal(JSON.stringify(h.rootFixture), original);
  } finally { await h.cleanup(); }
});

test("successful Apply sends exactly merged layout files through the cache-invalidating store API", async () => {
  const h = await setup();
  try {
    await h.prepare(); await h.validate(true);
    await h.click("Apply design");
    assert.deepEqual(h.mutations, [{ files: { ...h.rootFixture.files, "status-layout.tsx": code } }]);
    assert.equal(Object.hasOwn(h.mutations[0] as object, "compiled"), false, "do not carry old compiled property into updateRootComponent");
    assert.equal(document.querySelector('[data-test-preview]'), null);
  } finally { await h.cleanup(); }
});

test("Apply reads current store and rejects an intervening root or world change even before rerender", async () => {
  const h = await setup();
  try {
    await h.prepare(); await h.validate(true);
    h.state.worldDraft.rootComponent = { ...h.rootFixture, files: { ...h.rootFixture.files, "sprites.ts": "new artwork" } };
    await h.click("Apply design");
    assert.deepEqual(h.mutations, []);
    assert.match(document.body.textContent ?? "", /Preview the design again/);
    h.state.worldDraft.rootComponent = h.rootFixture;
    h.state.serverWorldId = "world-b";
    await h.click("Apply design");
    assert.deepEqual(h.mutations, []);
  } finally { await h.cleanup(); }
});

test("new source invalidates previous green validation and account changes block Apply", async () => {
  const h = await setup();
  try {
    await h.prepare(); await h.validate(true);
    await h.paste(code + "\n// revised design");
    assert.equal(h.button("Apply design"), undefined);
    await h.click("Check and preview design");
    assert.equal(h.button("Apply design")!.disabled, true, "new candidate cannot reuse old green state");
    await h.validate(true);
    h.setOwner("owner-b"); await h.render();
    assert.equal(h.button("Apply design")!.disabled, true, "account ownership must match preview");
    assert.deepEqual(h.mutations, []);
  } finally { await h.cleanup(); }
});

test("a delayed file read cannot overwrite later source or a newly selected account", async () => {
  const h = await setup();
  try {
    let release: (text: string) => void = () => {};
    const deferred = new Promise<string>(resolve => { release = resolve; });
    const file = { size: 10, text: () => deferred };
    const input = document.querySelector('[aria-label="Status design file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await React.act(async () => input.dispatchEvent(new h.dom.window.Event("change", { bubbles: true })));
    await h.paste(code);
    await React.act(async () => release("old file"));
    assert.equal((document.querySelector('[aria-label="Paste Status design"]') as HTMLTextAreaElement).value, code);
    let releaseAgain: (text: string) => void = () => {};
    const deferredAgain = new Promise<string>(resolve => { releaseAgain = resolve; });
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 10, text: () => deferredAgain }] });
    await React.act(async () => input.dispatchEvent(new h.dom.window.Event("change", { bubbles: true })));
    h.setOwner("owner-b"); await h.render();
    await React.act(async () => releaseAgain("previous account file"));
    assert.equal((document.querySelector('[aria-label="Paste Status design"]') as HTMLTextAreaElement).value, code);
    let releaseLast: (text: string) => void = () => {};
    const deferredLast = new Promise<string>(resolve => { releaseLast = resolve; });
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 10, text: () => deferredLast }] });
    await React.act(async () => input.dispatchEvent(new h.dom.window.Event("change", { bubbles: true })));
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 300000 }] });
    await React.act(async () => input.dispatchEvent(new h.dom.window.Event("change", { bubbles: true })));
    await React.act(async () => releaseLast("superseded file"));
    assert.equal((document.querySelector('[aria-label="Paste Status design"]') as HTMLTextAreaElement).value, code);
    assert.match(document.body.textContent ?? "", /smaller than 256 KB/);
    assert.deepEqual(h.mutations, []);
  } finally { await h.cleanup(); }
});
