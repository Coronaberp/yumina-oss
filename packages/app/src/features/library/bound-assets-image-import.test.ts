import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");

test("bound folder images share the importer while mixed files retain their destination and cancellation", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  globalThis.fetch = async () => Response.json({ data: [] });
  let owner = "owner", world = "world-a", fail = false, failName = "", cancel = false;
  const controller = new AbortController();
  const calls: Array<{ file: File; type: string; folder: string; options?: { signal?: AbortSignal } }> = [];
  let importer: { initialFiles?: File[]; crop?: string; preserveOriginal?: boolean; maxBytes?: number; onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void> } | null = null;
  const noop = () => {};
  const bindingState = { bindings: [{ id: "folder", name: "Art folder", assetCount: 0, previewAssetIds: [] }], worldId: "world-a", loading: false, fetch: noop, bind: noop, unbind: noop };
  const userAssets = { folders: [], fetchFolders: noop, deleteAsset: noop, moveAsset: noop, uploadAsset: async (file: File, type: string, folder: string, options?: { signal?: AbortSignal }) => { calls.push({ file, type, folder, options }); if (cancel) controller.abort(); return fail || file.name === failName ? null : { id: file.name }; } };
  const wrapper = (props: { children?: unknown }) => React.createElement("div", null, props.children);
  const mocks: Record<string, unknown> = {
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: owner } } }) },
    "@/edition/edition": { useFeature: () => false }, "@/edition/slots": { GenerationPanel: () => null },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/folder-bindings": { useFolderBindingStore: (selector: (state: typeof bindingState) => unknown) => selector(bindingState) },
    "@/stores/user-assets": { useUserAssetStore: (selector: (state: typeof userAssets) => unknown) => selector(userAssets) },
    "@/stores/editor": { useEditorStore: (selector: (state: object) => unknown) => selector({ serverWorldId: world }) },
    "@/lib/asset-upload": { getUploadMetadata: (file: File) => ({ type: file.type.startsWith("image/") ? "image" : "txt" }) },
    "@/lib/asset-url": {}, "@/lib/feedback": { feedback: { error: noop } },
    "@/hooks/use-copy-feedback": { useCopyFeedback: () => ({ copy: noop }) },
    "@/components/ui/dialog": { Dialog: () => null, DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper },
    "@/components/image-import-dialog": { ImageImportDialog: (props: NonNullable<typeof importer>) => { importer = props; return React.createElement("div", { "data-import": true }); } },
  };
  const module = { exports: {} as { BoundAssetsView: unknown } };
  const code = transform(readFileSync(new URL("./bound-assets-view.tsx", import.meta.url), "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const render = () => root.render(React.createElement(module.exports.BoundAssetsView, { worldId: world }));
  const image = new File(["image"], "image.png", { type: "image/png" }), note = new File(["note"], "note.txt", { type: "text/plain" });
  try {
    await React.act(async () => render());
    await React.act(async () => document.querySelector<HTMLButtonElement>('button[title="bindings.uploadToFolder"]')!.click());
    assert.ok(document.querySelector("[data-import]"), "bound image upload opens the same source dialog");
    assert.equal(importer!.crop, "none"); assert.equal(importer!.preserveOriginal, true); assert.equal(importer!.maxBytes, Infinity);
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [image, note] } });
    await React.act(async () => document.querySelector('.library-overview-surface')!.dispatchEvent(drop));
    assert.equal(calls.length, 0, "mixed files wait for image confirmation");
    assert.deepEqual(importer!.initialFiles, [image]);
    await React.act(async () => importer!.onImport([image], { signal: controller.signal, onProgress: noop }));
    assert.deepEqual(calls.map(call => [call.file.name, call.type, call.folder]), [["image.png", "image", "folder"], ["note.txt", "txt", "folder"]]);
    assert.equal(calls[0]?.options?.signal, controller.signal);
    await React.act(async () => document.querySelector('.library-overview-surface')!.dispatchEvent(drop));
    fail = true;
    await React.act(async () => { await assert.rejects(importer!.onImport([image], { signal: controller.signal, onProgress: noop })); });
    fail = false;
    const beforeRetry = calls.length;
    await React.act(async () => importer!.onImport([image], { signal: controller.signal, onProgress: noop }));
    assert.equal(calls.length, beforeRetry + 2, "the retained image confirmation can retry after a failure");
    const second = new File(["second"], "second.png", { type: "image/png" });
    await React.act(async () => document.querySelector('.library-overview-surface')!.dispatchEvent(drop));
    failName = second.name;
    const partialStart = calls.length;
    await React.act(async () => { await assert.rejects(importer!.onImport([image, second], { signal: controller.signal, onProgress: noop })); });
    failName = "";
    await React.act(async () => importer!.onImport([image, second], { signal: controller.signal, onProgress: noop }));
    assert.deepEqual(calls.slice(partialStart).map(call => call.file.name), [image.name, second.name, second.name, note.name], "retry skips images already stored before the failure");
    await React.act(async () => document.querySelector('.library-overview-surface')!.dispatchEvent(drop));
    cancel = true;
    const before = calls.length;
    await React.act(async () => { await assert.rejects(importer!.onImport([image], { signal: controller.signal, onProgress: noop })); });
    assert.equal(calls.length, before + 1, "cancellation stops later companion uploads");
    const stale = importer!;
    owner = "other"; world = "world-b"; await React.act(async () => render());
    await React.act(async () => { await assert.rejects(stale.onImport([image], { signal: new AbortController().signal, onProgress: noop })); });
    assert.equal(calls.length, before + 1, "old callbacks cannot target another account/world");
  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
