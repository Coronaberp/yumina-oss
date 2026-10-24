import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { JSDOM } from "jsdom";
import * as React from "react";

test("greeting images share import confirmation and keep caret, assets and cancellation guards", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const before = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const { create } = require("zustand");
  const editor = create(() => ({ serverWorldId: "world-a", worldDraft: { id: "draft-a" }, readOnlyInspect: false, editingLocked: false, guestMode: false, saveDraft: async () => true }));
  let importer: { onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>; onClose: () => void; initialFiles?: File[]; preserveOriginal?: boolean; crop?: string } | null = null;
  let library: { onSelect: (ref: string) => void } | null = null;
  let uploads = 0, finish: ((value: unknown) => void) | null = null;
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/editor": { useEditorStore: editor },
    "@/stores/assets": { useAssetStore: (selector: (s: object) => unknown) => selector({ uploadAsset: async () => { uploads++; return new Promise(resolve => { finish = resolve; }); } }) },
    "@/components/image-import-dialog": { ImageImportDialog: (props: typeof importer) => { importer = props; return React.createElement("div", { "data-import": true }); } },
    "@/lib/clipboard-image": { getImageFilesFromTransfer: (data: { files?: File[] }) => data?.files ?? [] },
    "@/lib/feedback": { feedback: { error() {} } },
    "@/lib/utils": { cn: (...args: unknown[]) => args.filter(Boolean).join(" ") },
    "../asset-picker": { AssetPicker: (props: typeof library) => { library = props; return React.createElement("div", { "data-library": true }); } },
    "@/components/ui/dropdown-menu": Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuTrigger"].map(key => [key, ({ children }: { children: React.ReactNode }) => children])),
  };
  const module = { exports: {} as { useImageInsert: (get: () => HTMLTextAreaElement | null) => { busy: boolean; openFiles: () => void; openLibrary: () => Promise<void>; overlays: React.ReactNode; dropProps: object } } };
  const source = readFileSync(new URL("./image-insert.tsx", import.meta.url), "utf8");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  let latest!: ReturnType<typeof module.exports.useImageInsert>;
  function Probe() {
    const insert = module.exports.useImageInsert(() => document.querySelector<HTMLTextAreaElement>("textarea"));
    React.useLayoutEffect(() => { latest = insert; });
    return React.createElement(React.Fragment, null, React.createElement("textarea", { defaultValue: "Hello world", ...insert.dropProps }), insert.overlays);
  }
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  const file = new File(["image"], "hello.png", { type: "image/png" });
  const context = () => { const controller = new AbortController(); return { controller, signal: controller.signal, onProgress() {} }; };
  try {
    await React.act(async () => mounted.render(React.createElement(Probe)));
    await React.act(async () => latest.openFiles());
    assert.ok(document.querySelector("[data-import]"), "image button must open the shared import modal");
    assert.equal(importer!.preserveOriginal, true); assert.equal(importer!.crop, "none"); assert.equal(uploads, 0);
    const area = document.querySelector("textarea")!; area.setSelectionRange(5, 5);
    let pending!: Promise<void>; const active = context();
    await React.act(async () => { pending = importer!.onImport([file], active); });
    assert.equal(uploads, 1); assert.equal(area.value, "Hello world");
    await React.act(async () => { finish!({ id: "asset-a" }); await pending; });
    assert.equal(area.value, "Hello\n[image:@asset:asset-a|alt=hello]\n world");
    await React.act(async () => importer!.onClose());
    await React.act(async () => latest.openLibrary());
    assert.ok(library); await React.act(async () => library!.onSelect("@asset:existing"));
    assert.match(area.value, /@asset:existing/);
    await React.act(async () => latest.openFiles());
    const value = area.value, cancel = context();
    await React.act(async () => { pending = importer!.onImport([file], cancel); });
    cancel.controller.abort();
    await React.act(async () => { importer!.onClose(); finish!({ id: "cancelled" }); await pending.catch(() => {}); });
    assert.equal(area.value, value, "cancel cannot insert a late upload");
    await React.act(async () => latest.openFiles());
    const switched = context();
    await React.act(async () => { pending = importer!.onImport([file], switched); });
    await React.act(async () => editor.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b" } }));
    await React.act(async () => { finish!({ id: "other-world" }); await pending.catch(() => {}); });
    assert.equal(area.value, value, "world change cannot insert into a new draft");
    await React.act(async () => latest.openFiles());
    const retry = context();
    await React.act(async () => { pending = importer!.onImport([file], retry); });
    await React.act(async () => { finish!(null); await assert.rejects(pending); });
    assert.equal(area.value, value);
    await React.act(async () => { pending = importer!.onImport([file], retry); });
    await React.act(async () => { finish!({ id: "retried" }); await pending; });
    assert.match(area.value, /@asset:retried/, "a failed upload keeps confirmation retryable");
    await React.act(async () => importer!.onClose());
    await React.act(async () => latest.openFiles());
    const abandoned = context(); let oldPending!: Promise<void>;
    await React.act(async () => { oldPending = importer!.onImport([file], abandoned); });
    const finishOld = finish!;
    await React.act(async () => { abandoned.controller.abort(); importer!.onClose(); });
    await React.act(async () => latest.openFiles());
    const fresh = context(), previousUploads = uploads;
    await React.act(async () => { pending = importer!.onImport([file], fresh); });
    assert.equal(uploads, previousUploads + 1, "a canceled upload cannot block the next confirmation");
    await React.act(async () => { finishOld({ id: "abandoned" }); await oldPending; });
    assert.equal(latest.busy, true, "an old completion cannot clear the new upload status");
    await React.act(async () => { finish!({ id: "fresh" }); await pending; });
    assert.match(area.value, /@asset:fresh/); assert.doesNotMatch(area.value, /@asset:abandoned/);
    await React.act(async () => importer!.onClose());
    await React.act(async () => latest.openFiles());
    const batch = context(), second = new File(["second"], "second.png", { type: "image/png" }), beforeBatch = area.value;
    await React.act(async () => { pending = importer!.onImport([file, second], batch); });
    await React.act(async () => { finish!({ id: "batch-a" }); });
    await React.act(async () => { finish!(null); await assert.rejects(pending); });
    assert.equal(area.value, beforeBatch, "partial upload success does not insert a partial batch");
    const beforeRetry = uploads;
    await React.act(async () => { pending = importer!.onImport([file, second], batch); });
    assert.equal(uploads, beforeRetry + 1, "retry reuses the already-registered first image");
    await React.act(async () => { finish!({ id: "batch-b" }); await pending; });
    assert.equal([...String(area.value).matchAll(/@asset:batch-a/g)].length, 1);
    assert.equal([...String(area.value).matchAll(/@asset:batch-b/g)].length, 1);
    await React.act(async () => importer!.onClose());
    const textPaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", { value: { files: [] } });
    await React.act(async () => area.dispatchEvent(textPaste));
    assert.equal(textPaste.defaultPrevented, false);
    const imagePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(imagePaste, "clipboardData", { value: { files: [file] } });
    await React.act(async () => area.dispatchEvent(imagePaste));
    assert.equal(imagePaste.defaultPrevented, true); assert.deepEqual(importer!.initialFiles, [file]);
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, value] of before) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
