import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as vn from "../lib/vn-assets";
import * as spriteImport from "../lib/sprite-import";

const require = createRequire(import.meta.url);
const React = require("react");
const { JSDOM } = require("jsdom");
const { transform } = require("sucrase");
const spriteTemplate = readFileSync(new URL("../../../../../../interfaces/vn/sprites.ts", import.meta.url), "utf8");
const sceneTemplate = readFileSync(new URL("../../../../../../interfaces/vn/scenes.ts", import.meta.url), "utf8");
interface Progress { fraction: number; loaded: number; total: number; bytesPerSecond: number }
interface ImportProps {
  multiple?: boolean; onImport: (files: File[], context: { signal: AbortSignal; onProgress: (progress: Progress) => void }) => Promise<void>;
  onClose: () => void;
}

async function fixture(kind: "sprite" | "background", run: (h: {
  open: (batch?: boolean) => Promise<void>; props: () => ImportProps; start: () => Promise<void>;
  finish: (result: { id: string } | Error) => Promise<unknown>; abort: () => void;
  config: () => { signal: AbortSignal; onProgress: (progress: Progress) => void };
  writes: Record<string, string>[]; progresses: Progress[]; uploadCount: () => number; reviewed: () => unknown[];
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const writes: Record<string, string>[] = [], progresses: Progress[] = [];
  const { create } = require("zustand");
  const store = create((set: (value: unknown) => void) => ({
    serverWorldId: "world-a", editingLocked: false, readOnlyInspect: false, guestMode: false,
    worldDraft: { id: "draft-a", entries: [{ id: "kei", name: "Kei", role: "character", content: "Preserve character" }], rootComponent: {
      id: "root-a", interfaceId: "vn", files: { "custom.ts": "PRESERVE CUSTOM SOURCE", "sprites.ts": spriteTemplate.replace("export const sprites = {};", 'export const sprites = { Kei: { normal: "@asset:old" } };'), "scenes.ts": sceneTemplate },
    } },
    updateRootComponent: ({ files }: { files: Record<string, string> }) => { writes.push(files); set((state: { worldDraft: { rootComponent: object } }) => ({ worldDraft: { ...state.worldDraft, rootComponent: { ...state.worldDraft.rootComponent, files } } })); },
  }));
  let importer: ImportProps | null = null;
  let resolveUpload!: (asset: { id: string }) => void, rejectUpload!: (error: Error) => void;
  let config!: { signal: AbortSignal; onProgress: (progress: Progress) => void };
  let uploadCount = 0, reviewed: unknown[] = [];
  let operation: Promise<unknown> = Promise.resolve();
  let controller = new AbortController();
  const wrapper = ({ children }: { children?: unknown }) => React.createElement("div", null, children);
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/editor": { useEditorStore: store }, "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "owner-a" } }, isPending: false }) },
    "@/lib/asset-upload": { uploadAssetWithPresignedUrl: (value: typeof config) => { config = value; uploadCount++; return new Promise((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; }); } },
    "@/lib/asset-url": { resolveImageUrl: (value: string) => value },
    "@/components/image-import-dialog": { ImageImportDialog: (props: ImportProps) => { importer = props; return React.createElement("div", { role: "dialog" }, "Shared image import"); } },
    "@/components/ui/select": { Select: wrapper }, "@/components/ui/radio-group": { RadioGroup: wrapper, RadioGroupItem: wrapper },
    "@/components/ui/checkbox": { Checkbox: () => null }, "@/components/ui/avatar": { Avatar: wrapper, AvatarFallback: wrapper },
    "@/components/image-lightbox": { ImageLightbox: () => null }, "@yumina/engine": { displayCharacterName: (name: string) => name },
    "../asset-picker": { AssetPicker: () => null }, "../lib/interface-presets": { interfaceKey: () => "vn" }, "../lib/vn-assets": vn,
    "../lib/sprite-import": spriteImport, "./debounced-field": { DebouncedTextarea: () => null }, "./sprite-catalog-dialog": { SpriteCatalogDialog: () => null },
    "./sprite-import-dialog": { SpriteImportDialog: ({ rows }: { rows: unknown[] }) => { reviewed = rows; return null; } },
    "../components/sprite-manager": { SpriteManager: () => null }, "../components/asset-suggestion-input": { AssetSuggestionInput: () => null },
    "@dnd-kit/core": { DndContext: wrapper, useSensors: () => [], useSensor: () => null },
    "@dnd-kit/sortable": { SortableContext: wrapper, useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef() {} }) }, "@dnd-kit/utilities": { CSS: { Transform: { toString: () => "" } } },
    "../../../../../../interfaces/vn/sprites.ts?raw": { __esModule: true, default: spriteTemplate }, "../../../../../../interfaces/vn/scenes.ts?raw": { __esModule: true, default: sceneTemplate },
  };
  const module = { exports: {} as { SpriteManager?: unknown; VnBackgroundsSection?: unknown } };
  const source = readFileSync(new URL(kind === "sprite" ? "./sprite-manager.tsx" : "../sections/visual-novel.tsx", import.meta.url), "utf8").replaceAll("import.meta.env", "({})");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  try {
    await React.act(async () => mounted.render(React.createElement(kind === "sprite" ? module.exports.SpriteManager : module.exports.VnBackgroundsSection)));
    await run({
      open: async batch => React.act(async () => {
        const label = kind === "background" ? "visualNovel.uploadBackground" : batch ? "spriteManager.importImages" : "spriteManager.replace";
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
        assert.ok(button, `Missing ${label}`); button.click();
      }),
      props: () => { assert.ok(importer); return importer; },
      start: async () => React.act(async () => {
        assert.ok(importer); controller = new AbortController();
        operation = Promise.resolve(importer.onImport([new File(["prepared"], "normal.png", { type: "image/png" })], { signal: controller.signal, onProgress: progress => progresses.push(progress) })).then(() => null, error => error);
        await Promise.resolve();
      }),
      finish: async result => { await React.act(async () => { if (result instanceof Error) rejectUpload(result); else resolveUpload(result); }); return React.act(async () => await operation); },
      abort: () => controller.abort(), config: () => config, writes, progresses, uploadCount: () => uploadCount, reviewed: () => reviewed,
    });
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

for (const kind of ["sprite", "background"] as const) {
  test(`${kind} single-image imports forward real upload progress and reject storage failures`, async () => fixture(kind, async h => {
    await h.open(); await h.start();
    const progress = { fraction: 0.4, loaded: 4, total: 10, bytesPerSecond: 2 };
    await React.act(async () => h.config().onProgress(progress));
    assert.deepEqual(h.progresses, [progress], "The shared import modal must receive actual destination progress");
    const error = await h.finish(new Error("Storage failed"));
    assert.match(String(error), /Storage failed/, "The caller must reject so the shared dialog retains its error/retry state");
    assert.equal(h.writes.length, 0);
  }));
  test(`${kind} shared cancellation aborts the request and prevents late assignment`, async () => fixture(kind, async h => {
    await h.open(); await h.start(); h.abort();
    assert.equal(h.config().signal.aborted, true);
    const error = await h.finish({ id: "late-image" });
    assert.ok(error instanceof Error, "A cancelled destination callback must not report successful completion");
    assert.equal(h.writes.length, 0);
  }));
  test(`${kind} failed confirmations retry successfully without duplicate destination requests`, async () => fixture(kind, async h => {
    await h.open(); await h.start();
    assert.match(String(await h.finish(new Error("Retryable storage failure"))), /Retryable storage failure/);
    await h.start();
    const duplicate = h.props().onImport([new File(["duplicate"], "duplicate.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress() {} }).catch(error => error);
    await Promise.resolve();
    assert.equal(h.uploadCount(), 2, "Only the initial attempt and one retry may reach storage");
    assert.equal(await h.finish({ id: "registered-retry" }), null);
    assert.ok(await duplicate instanceof Error);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.["custom.ts"], "PRESERVE CUSTOM SOURCE");
    assert.match(h.writes[0]?.[kind === "sprite" ? "sprites.ts" : "scenes.ts"] ?? "", /@asset:registered-retry/);
  }));
}

test("prepared sprite batches still stage review before any destination uploads", async () => fixture("sprite", async h => {
  await h.open(true); assert.equal(h.props().multiple, true); await h.start();
  assert.equal(h.uploadCount(), 0);
  assert.equal(h.reviewed().length, 1);
}));
