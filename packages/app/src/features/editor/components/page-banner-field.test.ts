import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const source = new URL("./page-banner-field.tsx", import.meta.url);
const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
const BANNER = "@asset:11111111-1111-4111-8111-111111111111";
const NEXT = "@asset:22222222-2222-4222-8222-222222222222";
const full = { x: 0, y: 0, zoom: 1, fit: "contain" };

test("page banner controls preserve portrait, use registered uploads/assets, remove and reject late results", async () => {
  assert.ok(existsSync(source), "Overview needs its independent page banner field");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { create } = require("zustand");
  const calls: unknown[] = [];
  let saves = 0, complete!: (value: unknown) => void;
  const portraitCrop = { x: 3, y: 2, zoom: 0.8, fit: "cover" };
  const store = create((set: (value: unknown) => void) => ({
    serverWorldId: "world-a", worldDraft: { id: "draft-a", avatar: "/portrait.png", coverCrop: portraitCrop, galleryCoverCrop: portraitCrop },
    readOnlyInspect: false, editingLocked: false, guestMode: false,
    setField: (field: string, value: unknown) => set((state: { worldDraft: object }) => ({ worldDraft: { ...state.worldDraft, [field]: value } })),
    saveDraft: async () => { saves++; return true; },
  }));
  let dialog: { onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>; onClose: () => void };
  let uploadPending: Promise<void> | null = null;
  let pickerSelect: ((ref: string) => void) | null = null;
  const mocks: Record<string, unknown> = {
    "@/components/image-import-dialog": { ImageImportDialog: (p: typeof dialog) => { dialog = p; return React.createElement("button", { onClick: p.onClose }, "Cancel image import"); } },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "owner-a" } } }) },
    "@/stores/editor": { useEditorStore: store },
    "@/lib/world-detail-media": { DEFAULT_WORLD_BANNER_CROP: full, normalizeWorldBannerCrop: (value: unknown) => value ?? full },
    "@/stores/assets": { useAssetStore: { getState: () => ({ uploadAsset: (...args: unknown[]) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); } }) } },
    "@/lib/cover-crop": { CroppedImage: (p: { src: string; className: string; crop: unknown }) => React.createElement("div", { "data-src": p.src, "data-crop": JSON.stringify(p.crop), className: p.className }) },
    "../asset-picker": { AssetPicker: (p: { onSelect: (ref: string) => void }) => { pickerSelect = p.onSelect; return React.createElement("button", { onClick: () => p.onSelect(BANNER) }, "Select registered image"); } },
    "./cover-crop-dialog": { CoverCropDialog: (p: { variant: string; onSave: (value: unknown) => void }) => React.createElement("button", { onClick: () => p.onSave({ bannerCrop: { x: 8, y: 0, zoom: 0.7, fit: "cover" } }) }, `Save ${p.variant} framing`) },
  };
  const module = { exports: {} as { PageBannerField: unknown } };
  const code = transform(readFileSync(source, "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  const click = async (label: string) => React.act(async () => { const node = [...document.querySelectorAll("button")].find(node => node.textContent === label); assert.ok(node, label); node.click(); });
  const upload = async () => {
    await click(store.getState().worldDraft.bannerImageUrl ? "Change banner" : "Upload banner");
    await React.act(async () => { uploadPending = dialog.onImport([new File(["x"], "banner.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress: () => {} }); });
  };
  const unchangedPortrait = () => { assert.equal(store.getState().worldDraft.avatar, "/portrait.png"); assert.deepEqual(store.getState().worldDraft.coverCrop, portraitCrop); assert.deepEqual(store.getState().worldDraft.galleryCoverCrop, portraitCrop); };
  try {
    await React.act(async () => mounted.render(React.createElement(module.exports.PageBannerField)));
    assert.match(document.body.textContent!, /Page banner/); assert.match(document.body.textContent!, /1600\s*×\s*500|1600\s*x\s*500/);
    assert.ok(document.querySelector('[data-banner-preview][class*="aspect-[16/5]"]'));
    await click("From assets"); const acceptedPicker = pickerSelect!; await click("Select registered image");
    await React.act(async () => acceptedPicker(NEXT));
    assert.equal(store.getState().worldDraft.bannerImageUrl, BANNER, "a slow callback from the accepted picker cannot replace the chosen image");
    assert.equal(store.getState().worldDraft.bannerImageUrl, BANNER); assert.deepEqual(store.getState().worldDraft.bannerCrop, full); unchangedPortrait();
    await click("Adjust banner framing"); await click("Save banner framing");
    assert.deepEqual(store.getState().worldDraft.bannerCrop, { x: 8, y: 0, zoom: 0.7, fit: "cover" }); unchangedPortrait();
    await click("Remove banner"); assert.equal(store.getState().worldDraft.bannerImageUrl, ""); unchangedPortrait();
    await upload(); assert.equal(calls.length, 1); assert.equal((calls[0] as unknown[])[0], "world-a"); assert.equal((calls[0] as unknown[])[2], "image");
    await React.act(async () => { complete({ id: NEXT.split(":")[1] }); await uploadPending; dialog.onClose(); });
    assert.equal([...document.querySelectorAll("button")].find(node => node.textContent === "Change banner")!.disabled, false, "accepted uploads release the busy controls");
    assert.equal(store.getState().worldDraft.bannerImageUrl, NEXT); assert.deepEqual(store.getState().worldDraft.bannerCrop, full); unchangedPortrait();
    await click("From assets"); const oldSelect = pickerSelect!;
    await upload();
    await React.act(async () => store.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b", avatar: "/portrait-b.png" } }));
    await React.act(async () => { oldSelect(BANNER); complete({ id: NEXT.split(":")[1] }); await uploadPending?.catch(() => {}); });
    assert.equal(store.getState().worldDraft.bannerImageUrl, undefined, "old uploads and picker callbacks cannot modify another world");
    await React.act(async () => store.setState({ readOnlyInspect: true }));
    assert.ok([...document.querySelectorAll("button")].every(node => node.disabled), "read-only controls are disabled");
    assert.ok(saves >= 4, "normal draft saves persist banner actions");
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
