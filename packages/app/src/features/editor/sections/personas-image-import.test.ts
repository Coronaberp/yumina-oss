import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const { JSDOM } = require("jsdom");
const { transform } = require("sucrase");
const expressions = ["normal", "happy", "sad", "angry", "shy", "smug"];

interface ImportContext { signal: AbortSignal; onProgress: (progress: unknown) => void }
interface ImportProps {
  accept?: string; crop?: string; preserveOriginal?: boolean; maxBytes?: number; maxFiles?: number; multiple?: boolean;
  onImport: (files: File[], context: ImportContext) => Promise<void>; onClose: () => void;
}

async function fixture(run: (harness: {
  store: ReturnType<typeof createStore>; click: (label: string) => Promise<void>; render: () => Promise<void>;
  importImage: () => Promise<void>; complete: (asset: { id: string; url: string } | null) => void;
  pending: () => Promise<void>; cancel: () => Promise<void>; props: () => ImportProps;
  uploads: unknown[][]; signal: () => AbortSignal; setOwner: (id: string) => Promise<void>;
  failure: () => unknown;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const store = createStore();
  let owner = "owner-a", importer: ImportProps | null = null;
  const uploads: unknown[][] = [];
  let resolveUpload!: (asset: { id: string; url: string } | null) => void;
  let operation: Promise<void> = Promise.resolve();
  let failure: unknown;
  let controller = new AbortController();
  const mocks: Record<string, unknown> = {
    "@/stores/editor": { useEditorStore: store },
    "@/stores/assets": { useAssetStore: { getState: () => ({ uploadAsset: (...args: unknown[]) => { uploads.push(args); return new Promise(resolve => { resolveUpload = resolve; }); } }) } },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: owner } }, isPending: false }) },
    "@/lib/asset-url": { resolveImageUrl: (value: string) => value },
    "@yumina/shared": { personaSpriteExpressions: expressions },
    "@/components/ui/button": { Button: (props: Record<string, unknown>) => { const clean = { ...props }; delete clean.variant; delete clean.size; return React.createElement("button", clean); } },
    "@/components/ui/input": { Input: (props: object) => React.createElement("input", props) },
    "@/components/ui/field-error": { FieldError: ({ message }: { message?: string }) => message ? React.createElement("p", { role: "alert" }, message) : null },
    "@/components/image-import-dialog": { ImageImportDialog: (props: ImportProps) => { importer = props; return React.createElement("div", { role: "dialog" }, "Import persona image"); } },
  };
  const module = { exports: {} as { PersonasSection: unknown } };
  const source = readFileSync(new URL("./personas.tsx", import.meta.url), "utf8");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  const render = async () => React.act(async () => mounted.render(React.createElement(module.exports.PersonasSection)));
  const click = async (label: string) => React.act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
    assert.ok(button, `Missing action: ${label}`); button.click();
  });
  try {
    await render();
    await run({
      store, click, render, uploads,
      props: () => { assert.ok(importer, "Image upload must open the shared import modal"); return importer; },
      importImage: async () => React.act(async () => {
        assert.ok(importer, "Image upload must open the shared import modal");
        controller = new AbortController();
        failure = undefined;
        operation = Promise.resolve(importer.onImport([new File(["original bytes"], "portrait.webp", { type: "image/webp" })], { signal: controller.signal, onProgress: () => {} })).catch(error => { failure = error; });
        await Promise.resolve();
      }),
      complete: asset => resolveUpload(asset),
      pending: async () => React.act(async () => { await operation; }),
      cancel: async () => React.act(async () => { controller.abort(); importer?.onClose(); }),
      signal: () => (uploads.at(-1)?.[3] as { signal: AbortSignal }).signal,
      failure: () => failure,
      setOwner: async id => { owner = id; await render(); },
    });
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

function createStore() {
  return require("zustand").create((set: (value: unknown) => void) => ({
    serverWorldId: "world-a", readOnlyInspect: false, editingLocked: false, guestMode: false, loadingWorld: false,
    worldDraft: { id: "draft-a", custom: { source: "CUSTOM WORLD CODE" }, personaPresets: [
      { id: "alice", name: "Alice", avatarUrl: "/old-picture", sprites: { happy: "/happy", normal: "/normal" }, appearance: "Keep appearance", personality: "Keep personality", backstory: "Keep background", custom: { source: "CUSTOM PERSONA CODE" } },
      { id: "bob", name: "Bob", avatarUrl: "/bob" },
    ] },
    setField: (key: string, value: unknown) => set((state: { worldDraft: object }) => ({ worldDraft: { ...state.worldDraft, [key]: value } })),
  }));
}

test("persona pictures use the shared original-image flow and retain URL fields and authored data", async () => fixture(async h => {
  await h.click("Upload picture");
  assert.ok(document.querySelector('[role="dialog"]'), "Picture upload must open the shared modal");
  assert.equal(document.querySelector('input[type="file"]'), null);
  assert.deepEqual([h.props().crop, h.props().preserveOriginal, h.props().maxBytes, h.props().maxFiles, h.props().accept], ["none", true, Infinity, 1, "image/*"]);
  await h.importImage();
  assert.deepEqual(h.uploads[0]?.slice(0, 1), ["world-a"]);
  assert.equal(h.uploads[0]?.[2], "image");
  assert.equal((h.uploads[0]?.[3] as { silent: boolean }).silent, true);
  assert.equal(typeof (h.uploads[0]?.[3] as { onProgress: unknown }).onProgress, "function");
  await React.act(async () => {
    const state = h.store.getState();
    state.setField("personaPresets", state.worldDraft.personaPresets.map((p: { id: string }) => p.id === "alice" ? { ...p, backstory: "Changed during upload" } : p));
  });
  const before = structuredClone(h.store.getState().worldDraft);
  await React.act(async () => h.complete({ id: "new-asset", url: "/cdn/new-picture" })); await h.pending();
  assert.deepEqual(h.store.getState().worldDraft, { ...before, personaPresets: [{ ...before.personaPresets[0], avatarUrl: "/cdn/new-picture" }, before.personaPresets[1]] });
}));

test("each of the six persona expressions writes only its selected sprite URL", async () => fixture(async h => {
  for (const expression of expressions) {
    const before = structuredClone(h.store.getState().worldDraft.personaPresets);
    await h.click(`Upload ${expression} sprite for Alice`); await h.importImage();
    await React.act(async () => h.complete({ id: expression, url: `/cdn/${expression}` })); await h.pending();
    assert.deepEqual(h.store.getState().worldDraft.personaPresets, [{ ...before[0], sprites: { ...before[0].sprites, [expression]: `/cdn/${expression}` } }, before[1]]);
    await h.cancel();
  }
}));

test("persona imports cannot apply after cancel, account/world/target changes, or edit locking", async () => {
  for (const change of ["cancel", "account", "world", "removed", "replaced", "locked", "inspect", "guest"]) {
    await fixture(async h => {
      await h.click("Upload happy sprite for Alice"); await h.importImage();
      await React.act(async () => {
        const state = h.store.getState();
        if (change === "world") h.store.setState({ serverWorldId: "world-b", worldDraft: { ...state.worldDraft, id: "draft-b" } });
        if (change === "removed") state.setField("personaPresets", state.worldDraft.personaPresets.filter((p: { id: string }) => p.id !== "alice"));
        if (change === "replaced") state.setField("personaPresets", state.worldDraft.personaPresets.map((p: { id: string; sprites?: object }) => p.id === "alice" ? { ...p, sprites: { ...p.sprites, happy: "/newer-choice" } } : p));
        if (change === "locked") h.store.setState({ editingLocked: true });
        if (change === "inspect") h.store.setState({ readOnlyInspect: true });
        if (change === "guest") h.store.setState({ guestMode: true });
      });
      if (change === "cancel") await h.cancel();
      if (change === "account") await h.setOwner("owner-b");
      const expected = structuredClone(h.store.getState().worldDraft);
      assert.equal(h.signal().aborted, true, `${change} must abort the destination request`);
      await React.act(async () => h.complete({ id: "late", url: "/cdn/late" })); await h.pending();
      assert.deepEqual(h.store.getState().worldDraft, expected, `${change} must discard a late image result`);
    });
  }
});

test("failed persona uploads remain retryable and duplicate confirmations cannot write twice", async () => fixture(async h => {
  await h.click("Upload picture"); await h.importImage();
  await React.act(async () => h.complete(null)); await h.pending();
  assert.match(String(h.failure()), /Could not upload the persona picture/);
  assert.equal(h.store.getState().worldDraft.personaPresets[0].avatarUrl, "/old-picture");
  assert.ok(document.querySelector('[role="dialog"]'));
  const callback = h.props().onImport;
  await h.importImage();
  const duplicate = callback([new File(["duplicate"], "duplicate.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress: () => {} });
  await Promise.resolve();
  assert.equal(h.uploads.length, 2, "A confirmation already uploading cannot start a duplicate request");
  await React.act(async () => h.complete({ id: "retry", url: "/cdn/retry" })); await h.pending(); await duplicate;
  assert.equal(h.store.getState().worldDraft.personaPresets[0].avatarUrl, "/cdn/retry");
}));
