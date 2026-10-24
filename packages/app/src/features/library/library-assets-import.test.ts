import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("library drops guard account changes, prepare loose images, and correct invalid pages once", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  let owner = "A", staged = 0, uploads = 0;
  let failUpload = false, cancelUpload = false, failName = "";
  const uploadedFiles: string[] = [];
  const uploadOptions: Array<{ signal?: AbortSignal; silent?: boolean }> = [];
  const importController = new AbortController();
  let importImages!: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>;
  const fetches: number[] = [];
  const noop = () => {};
  let resolveRead!: (result: { files: { file: File; path: string }[]; hasDirectories: boolean }) => void;
  let pendingRead = new Promise<{ files: { file: File; path: string }[]; hasDirectories: boolean }>((resolve) => { resolveRead = resolve; });
  const state = {
    assets: [], folders: [], storage: { used: 0, limit: 1000000 }, loading: false, uploading: false, uploadingCount: 0,
    page: 1, total: 0, pageSize: 50,
    fetchAssets: (opts: { page?: number }) => { fetches.push(opts.page ?? state.page); }, fetchFolders: async () => {},
    uploadAsset: async (_file: File, _type: string, _folder: unknown, options: { signal?: AbortSignal; silent?: boolean }) => { uploads++; uploadedFiles.push(_file.name); uploadOptions.push(options); if (cancelUpload) importController.abort(); return failUpload || _file.name === failName ? null : {}; }, fetchAssetById: async () => null,
    deleteAsset: noop, renameAsset: noop, moveAsset: noop, createFolder: noop, renameFolder: noop, deleteFolder: noop,
  };
  const t = (key: string) => key;
  const empty = () => null;
  const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const require = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    "@/stores/asset-import": { assetImportStore: { getState: () => ({ resetOwner: noop }) }, useAssetImportStore: (selector: (s: object) => unknown) => selector({ task: null, revision: 0 }) },
    "react-i18next": { useTranslation: () => ({ t }) },
    "@/stores/user-assets": { useUserAssetStore: (selector: (value: typeof state) => unknown) => selector(state) },
    "@/stores/worlds": { useWorldsStore: (selector: (value: object) => unknown) => selector({ worlds: [], fetchWorlds: noop }) },
    "@/stores/folder-bindings": { useFolderBindingStore: (selector: (value: object) => unknown) => selector({ bind: noop, unbind: noop }) },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ isAuthenticated: true, requireAuth: noop, session: { user: { id: owner } } }) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: owner } } }) },
    "@/lib/feedback": { feedback: { error: noop } },
    "@/hooks/use-copy-feedback": { useCopyFeedback: () => ({ copied: false, copy: noop }) },
    "@/lib/asset-url": {}, "@/lib/asset-upload": { getUploadMetadata: (file: File) => ({ type: file.name.endsWith(".png") ? "image" : "txt" }) },
    "@/lib/asset-folder-import": { readDroppedAssets: () => pendingRead, planFolderImport: () => { staged++; return {}; } },
    "@/components/ui/dialog": { Dialog: empty, DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper, DialogFooter: wrapper },
    "@/components/ui/context-menu": {},
    "@/components/ui/dropdown-menu": { DropdownMenu: wrapper, DropdownMenuTrigger: wrapper, DropdownMenuContent: wrapper, DropdownMenuItem: wrapper },
    "./asset-pagination": { AssetPagination: empty }, "./folder-upload-dialog": { FolderUploadDialog: empty },
    "./library-empty-state": { LibraryEmptyState: empty }, "./bulk-actions-bar": { BulkActionsBar: empty },
    "@/components/image-import-dialog": { ImageImportDialog: ({ initialFiles, onImport }: { initialFiles?: File[]; onImport: typeof importImages }) => { importImages = onImport; return createElement("button", { "data-testid": "image-import", onClick: () => void onImport([new File(["cropped"], "cropped.png", { type: "image/png" })], { signal: importController.signal, onProgress: noop }) }, initialFiles?.map(file => file.name).join(",")); } },
    "@/edition/edition": { useFeature: () => false }, "@/edition/slots": { GenerationPanel: empty },
  };
  const module = { exports: {} as { LibraryAssetsTab: ComponentType } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./library-assets-tab.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = () => root.render(createElement(module.exports.LibraryAssetsTab));
  try {
    await act(async () => render());
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => "" } });
    await act(async () => { dom.window.document.querySelector(".relative")!.dispatchEvent(drop); });
    owner = "B";
    await act(async () => render());
    await act(async () => resolveRead({ files: [{ file: new File(["a"], "a.txt"), path: "private/a.txt" }], hasDirectories: true }));
    assert.equal(staged, 0);
    assert.equal(uploads, 0);
    pendingRead = Promise.resolve({ files: [{ file: new File(["image"], "dropped.png"), path: "dropped.png" }, { file: new File(["text"], "notes.txt"), path: "notes.txt" }], hasDirectories: false });
    const imageDrop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(imageDrop, "dataTransfer", { value: { getData: () => "" } });
    await act(async () => { dom.window.document.querySelector(".relative")!.dispatchEvent(imageDrop); });
    const importer = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="image-import"]');
    assert.equal(importer?.textContent, "dropped.png", "loose images must be prepared before uploading");
    assert.equal(uploads, 0, "mixed dropped files must wait for crop/import completion");
    await act(async () => importer!.click());
    assert.equal(uploads, 2, "prepared image and accompanying non-image should both upload");
    assert.equal(uploadOptions[0]?.signal, importController.signal, "dialog cancellation must reach image storage");
    assert.equal(uploadOptions[0]?.silent, true, "modal retains upload errors instead of duplicate toasts");
    await act(async () => { dom.window.document.querySelector(".relative")!.dispatchEvent(imageDrop); });
    failUpload = true;
    await act(async () => { await assert.rejects(importImages([new File(["retry"], "retry.png", { type: "image/png" })], { signal: importController.signal, onProgress: noop })); });
    failUpload = false;
    const beforeRetry = uploads;
    await act(async () => importImages([new File(["retry"], "retry.png", { type: "image/png" })], { signal: importController.signal, onProgress: noop }));
    assert.equal(uploads, beforeRetry + 2, "a failed image confirmation remains usable for retry and its companion");
    const first = new File(["first"], "first.png", { type: "image/png" }), second = new File(["second"], "second.png", { type: "image/png" });
    await act(async () => { dom.window.document.querySelector(".relative")!.dispatchEvent(imageDrop); });
    failName = second.name;
    const partialStart = uploadedFiles.length;
    await act(async () => { await assert.rejects(importImages([first, second], { signal: importController.signal, onProgress: noop })); });
    failName = "";
    await act(async () => importImages([first, second], { signal: importController.signal, onProgress: noop }));
    assert.deepEqual(uploadedFiles.slice(partialStart), [first.name, second.name, second.name, "notes.txt"], "retry must skip images stored before a later failure");
    await act(async () => { dom.window.document.querySelector(".relative")!.dispatchEvent(imageDrop); });
    cancelUpload = true;
    const beforeCancel = uploads;
    await act(async () => { await assert.rejects(importImages([new File(["cancel"], "cancel.png", { type: "image/png" })], { signal: importController.signal, onProgress: noop })); });
    assert.equal(uploads, beforeCancel + 1, "cancelled image batches must not upload their non-image companions");
    state.page = 101; state.total = 51;
    await act(async () => render());
    assert.equal(fetches.filter((page) => page === 2).length, 1);
    state.loading = true;
    await act(async () => render());
    state.loading = false;
    await act(async () => render());
    assert.equal(fetches.filter((page) => page === 2).length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
