/* eslint-disable @typescript-eslint/no-explicit-any -- Mounted source-transform fixtures mock destination contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as crop from "../../../lib/cropping";

const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
const file = new File(["original image bytes"], "art.png", { type: "image/png" });
const raster = "image/jpeg,image/png,image/gif,image/webp";
const banner = "@asset:11111111-1111-4111-8111-111111111111";

async function fixture(kind: "overview" | "banner" | "quick-cover" | "quick-gallery") {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { create } = require("zustand");
  let account = "owner-a", picker: any = null, framing: any = null;
  let saves = 0, imports: any = null, upload: (options: any) => Promise<any> = async () => ({ thumbnailUrl: "/new-cover.png", url: "/new-gallery.png", galleryImages: ["/new-gallery.png"] });
  let assetUpload: (...args: any[]) => Promise<any> = async () => ({ id: banner.slice(7) });
  const calls: any[] = [], assetCalls: any[] = [];
  const store = create((set: any) => ({
    serverWorldId: "world-a", worldDraft: { id: "draft-a", name: "World", description: "", avatar: "/portrait.png", bannerImageUrl: banner, coverCrop: { x: 4, y: 2, zoom: 0.8, fit: "cover" }, galleryCoverCrop: { x: 0, y: 0, zoom: 1, fit: "cover" } },
    galleryImages: [], language: null, readOnlyInspect: false, editingLocked: false, guestMode: false,
    setField: (field: string, value: unknown) => set((s: any) => ({ worldDraft: { ...s.worldDraft, [field]: value } })),
    setGalleryImages: (images: string[]) => set({ galleryImages: images }), setLanguage: () => {},
    saveDraft: async () => { saves++; return true; },
  }));
  const pass = (p: any) => React.createElement("div", null, p.children);
  const mocks: Record<string, any> = {
    "@/stores/editor": { useEditorStore: store },
    "react-i18next": { useTranslation: () => ({ t: (key: string, opts?: any) => opts?.defaultValue ?? key }) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: account } } }) },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ session: { user: { id: account } }, requireAuth: () => {}, isAuthenticated: true }) },
    "@/components/image-import-dialog": { ImageImportDialog: (p: any) => { imports = p; return React.createElement("div", { "data-image-import": true }, React.createElement("button", { onClick: p.onClose }, "Cancel image import")); } },
    "@/components/ui/global-confirm-dialog": {}, "@/components/ui/select": { Select: pass },
    "@/components/ui/field-error": { FieldError: (p: any) => p.message ? React.createElement("p", { role: "alert" }, p.message) : null },
    "@/components/ui/two-tap-delete-button": { TwoTapDeleteButton: (p: any) => React.createElement("button", { disabled: p.disabled, onClick: p.onConfirm }, p.children) },
    "@/features/library/world-update-history": { WorldUpdateHistory: () => null },
    "@yumina/shared": { MAX_WORLD_NAME: 100, MAX_WORLD_DESCRIPTION: 10000 }, "@/lib/import-world": {},
    "@/lib/asset-upload": { uploadAssetWithPresignedUrl: (options: any) => { calls.push(options); return upload(options); }, getAssetUploadErrorMessage: (error: Error) => error.message },
    "@/stores/assets": { useAssetStore: { getState: () => ({ uploadAsset: (...args: any[]) => { assetCalls.push(args); return assetUpload(...args); } }) } },
    "@/lib/cover-crop": { ...crop, CroppedImage: (p: any) => React.createElement("div", { "data-src": p.src, className: p.className }) },
    "@/lib/world-cover-crop": { getWorldGalleryDisplayCrop: crop.normalizeCoverCrop },
    "@/lib/world-detail-media": { DEFAULT_WORLD_BANNER_CROP: { x: 0, y: 0, zoom: 1, fit: "contain" }, normalizeWorldBannerCrop: (v: any) => v ?? { x: 0, y: 0, zoom: 1, fit: "contain" } },
    "../asset-picker": { AssetPicker: (p: any) => { picker = p; return React.createElement("div", { "data-picker": true }); } }, "./asset-picker": { AssetPicker: () => null },
    "../components/cover-crop-dialog": { CoverCropDialog: (p: any) => { framing = p; return React.createElement("div", { "data-framing": true }); } },
    "./cover-crop-dialog": { CoverCropDialog: () => React.createElement("div", { "data-framing": true }) },
    "../components/page-banner-field": { PageBannerField: () => null },
    "@/lib/utils": { cn: (...values: any[]) => values.filter(Boolean).join(" ") },
    "@/edition/edition": { getEditionInfo: () => ({ features: { bundles: false } }) },
  };
  const relative = kind === "overview" ? "../sections/overview.tsx" : kind === "banner" ? "./page-banner-field.tsx" : "../quick-create-editor.tsx";
  let source = readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("import.meta.env", "({})");
  if (kind.startsWith("quick")) source += "\nVisualLayerSection = () => null; SimpleBgmCard = () => null; export { CoverSection, MoreDisclosure };";
  const module = { exports: {} as any };
  const code = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? (id.startsWith("@/") || id.startsWith("./") ? {} : require(id)), module, module.exports);
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  const Component = module.exports[kind === "overview" ? "OverviewSection" : kind === "banner" ? "PageBannerField" : kind === "quick-cover" ? "CoverSection" : "MoreDisclosure"];
  await React.act(async () => mounted.render(React.createElement(Component, { onOpenFullEditor: () => {} })));
  return {
    store, calls, assetCalls, get imports() { return imports; }, get picker() { return picker; }, get framing() { return framing; },
    setAccount: async (id: string) => { account = id; await React.act(async () => mounted.render(React.createElement(Component, { onOpenFullEditor: () => {} }))); },
    get saves() { return saves; },
    setUpload: (fn: typeof upload) => { upload = fn; }, setAssetUpload: (fn: typeof assetUpload) => { assetUpload = fn; },
    click: async (label: string) => React.act(async () => { const button = [...document.querySelectorAll("button")].find(n => n.textContent === label); assert.ok(button, label); button.click(); }),
    close: async () => { await React.act(async () => mounted.unmount()); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

function policy(props: any) {
  assert.ok(props, "the image button must open ImageImportDialog");
  assert.equal(props.crop, "none"); assert.equal(props.preserveOriginal, true);
  assert.equal(props.maxBytes, Infinity); assert.equal(props.accept, raster); assert.equal(props.maxFiles, 1);
}

test("Overview imports original cover/gallery through the shared modal and preserves independent banner framing", async () => {
  const f = await fixture("overview");
  try {
    await f.click("overview.changeCover"); policy(f.imports);
    const context = { signal: new AbortController().signal, onProgress: () => {} };
    await React.act(async () => f.imports.onImport([file], context));
    assert.equal(f.calls[0].file, file); assert.equal(f.calls[0].prepareUrl, "/api/worlds/world-a/thumbnail"); assert.equal(f.calls[0].registerUrl, "/api/worlds/world-a/thumbnail/confirm");
    assert.equal(f.calls[0].signal, context.signal); assert.equal(f.calls[0].onProgress, context.onProgress);
    assert.equal(f.store.getState().worldDraft.avatar, "/new-cover.png"); assert.equal(f.store.getState().worldDraft.bannerImageUrl, banner); assert.ok(document.querySelector("[data-framing]"));
    await f.click("Cancel image import");
    const add = [...document.querySelectorAll("button")].find(n => n.textContent === "overview.upload"); assert.ok(add);
    await React.act(async () => add.click()); policy(f.imports);
    await React.act(async () => f.imports.onImport([file], context));
    assert.equal(f.calls[1].prepareUrl, "/api/worlds/world-a/gallery/upload-url"); assert.equal(f.calls[1].registerUrl, "/api/worlds/world-a/gallery/confirm"); assert.deepEqual(f.store.getState().galleryImages, ["/new-gallery.png"]);
  } finally { await f.close(); }
});

test("banner modal forwards cancellation/progress and refuses late uploads after cancel or world switch", async () => {
  const f = await fixture("banner");
  try {
    await f.click("Change banner"); policy(f.imports);
    let complete!: (asset: any) => void;
    f.setAssetUpload(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController(), onProgress = () => {};
    let pending!: Promise<void>;
    await React.act(async () => { pending = f.imports.onImport([file], { signal: controller.signal, onProgress }); });
    assert.equal(f.assetCalls[0][0], "world-a"); assert.equal(f.assetCalls[0][1], file); assert.equal(f.assetCalls[0][2], "image"); assert.equal(f.assetCalls[0][3].signal, controller.signal); assert.equal(f.assetCalls[0][3].onProgress, onProgress);
    controller.abort(); await f.click("Cancel image import");
    await React.act(async () => { complete({ id: "22222222-2222-4222-8222-222222222222" }); await pending.catch(() => {}); });
    assert.equal(f.store.getState().worldDraft.bannerImageUrl, banner); assert.equal(f.saves, 0);
    await f.click("Change banner");
    await React.act(async () => { pending = f.imports.onImport([file], { signal: new AbortController().signal, onProgress }); });
    await React.act(async () => f.store.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b", avatar: "/other.png" } }));
    await React.act(async () => { complete({ id: "22222222-2222-4222-8222-222222222222" }); await pending.catch(() => {}); });
    assert.equal(f.store.getState().worldDraft.bannerImageUrl, undefined); assert.equal(f.store.getState().worldDraft.avatar, "/other.png");
  } finally { await f.close(); }
});

test("Quick Create cover uses the existing thumbnail contract and ignores late world results", async () => {
  const f = await fixture("quick-cover");
  try {
    await f.click("simple.cover.replace"); policy(f.imports);
    let complete!: (value: any) => void; f.setUpload(() => new Promise(resolve => { complete = resolve; }));
    const context = { signal: new AbortController().signal, onProgress: () => {} }; let pending!: Promise<void>;
    await React.act(async () => { pending = f.imports.onImport([file], context); });
    assert.equal(f.calls[0].prepareUrl, "/api/worlds/world-a/thumbnail"); assert.equal(f.calls[0].signal, context.signal);
    await React.act(async () => f.store.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b", avatar: "/other.png" } }));
    await React.act(async () => { complete({ thumbnailUrl: "/stale.png" }); await pending.catch(() => {}); });
    assert.equal(f.store.getState().worldDraft.avatar, "/other.png");
  } finally { await f.close(); }
});

test("Quick Create gallery retains eight-item cap and keeps failed import available for retry", async () => {
  const f = await fixture("quick-gallery");
  try {
    const add = [...document.querySelectorAll("button")].find(n => n.className.includes("aspect-video")); assert.ok(add);
    await React.act(async () => add.click()); policy(f.imports);
    f.setUpload(async () => { throw Error("Upload failed"); });
    await React.act(async () => assert.rejects(f.imports.onImport([file], { signal: new AbortController().signal, onProgress: () => {} }), /Upload failed/));
    assert.ok(document.querySelector("[data-image-import]")); assert.deepEqual(f.store.getState().galleryImages, []);
    await React.act(async () => f.store.setState({ galleryImages: Array.from({ length: 8 }, (_, i) => `/image-${i}.png`) }));
    await f.click("Cancel image import");
    assert.equal([...document.querySelectorAll("button")].find(n => n.className.includes("aspect-video"))?.disabled, true);
  } finally { await f.close(); }
});


for (const kind of ["overview", "banner", "quick-cover", "quick-gallery"] as const) {
  test(`${kind} upload failure is retryable and duplicate confirmations do not upload twice`, async () => {
    const f = await fixture(kind);
    try {
      if (kind === "overview") await f.click("overview.changeCover");
      else if (kind === "banner") await f.click("Change banner");
      else if (kind === "quick-cover") await f.click("simple.cover.replace");
      else await React.act(async () => [...document.querySelectorAll("button")].find(n => n.className.includes("aspect-video"))!.click());
      const callback = f.imports.onImport;
      const context = { signal: new AbortController().signal, onProgress: () => {} };
      f.setUpload(async () => { throw Error("Upload failed"); });
      f.setAssetUpload(async () => null);
      await React.act(async () => assert.rejects(callback([file], context), /upload|Upload/));
      assert.ok(document.querySelector("[data-image-import]"));
      let complete!: (value: any) => void;
      f.setUpload(() => new Promise(resolve => { complete = resolve; }));
      f.setAssetUpload(() => new Promise(resolve => { complete = resolve; }));
      let pending!: Promise<void>;
      await React.act(async () => { pending = callback([file], context); });
      await React.act(async () => callback([file], context));
      assert.equal(kind === "banner" ? f.assetCalls.length : f.calls.length, 2, "one failed attempt plus exactly one retry");
      await React.act(async () => { complete({ id: "22222222-2222-4222-8222-222222222222", thumbnailUrl: "/retry-cover.png", url: "/retry-gallery.png" }); await pending; });
      if (kind === "banner") { assert.equal(f.store.getState().worldDraft.bannerImageUrl, "@asset:22222222-2222-4222-8222-222222222222"); assert.equal(f.saves, 1); }
      else if (kind === "quick-gallery") assert.deepEqual(f.store.getState().galleryImages, ["/retry-gallery.png"]);
      else assert.equal(f.store.getState().worldDraft.avatar, "/retry-cover.png");
      await React.act(async () => assert.rejects(callback([file], context), /destination changed/));
    } finally { await f.close(); }
  });
}

for (const action of ["cancel", "account", "custom"] as const) {
  test(`Overview ${action} retires a pending cover without replacing current content`, async () => {
    const f = await fixture("overview");
    try {
      await f.click("overview.changeCover");
      const callback = f.imports.onImport;
      let complete!: (value: any) => void; f.setUpload(() => new Promise(resolve => { complete = resolve; }));
      let pending!: Promise<void>;
      await React.act(async () => { pending = callback([file], { signal: new AbortController().signal, onProgress: () => {} }); });
      if (action === "cancel") await f.click("Cancel image import");
      else if (action === "account") await f.setAccount("owner-b");
      else await React.act(async () => f.store.getState().setField("avatar", "/custom.png"));
      await React.act(async () => { complete({ thumbnailUrl: "/stale.png" }); await assert.rejects(pending, /destination changed/); });
      assert.equal(f.store.getState().worldDraft.avatar, action === "custom" ? "/custom.png" : "/portrait.png");
      assert.equal(f.saves, 0);
    } finally { await f.close(); }
  });
}

test("banner preview keeps its opening target when custom artwork changes before confirmation", async () => {
  const f = await fixture("banner");
  try {
    await f.click("Change banner"); const callback = f.imports.onImport;
    await React.act(async () => f.store.getState().setField("bannerImageUrl", "@asset:33333333-3333-4333-8333-333333333333"));
    await React.act(async () => assert.rejects(callback([file], { signal: new AbortController().signal, onProgress: () => {} }), /destination changed/));
    assert.equal(f.assetCalls.length, 0); assert.equal(f.saves, 0);
  } finally { await f.close(); }
});

test("Overview From Assets and crop callbacks cannot borrow a later world's target", async () => {
  const f = await fixture("overview");
  const previousFetch = globalThis.fetch; const requests: string[] = [];
  globalThis.fetch = async (input: any) => { requests.push(String(input)); return new Response(JSON.stringify({ data: { thumbnailUrl: "/portrait.png", url: "/asset-gallery.png" } }), { status: 200, headers: { "Content-Type": "application/json" } }); };
  try {
    await f.click("overview.fromAssets"); const oldPicker = f.picker;
    await f.click("Adjust crop"); const oldCrop = f.framing;
    const initialCrop = { x: 0, y: 0, zoom: 1, fit: "contain" };
    await React.act(async () => f.store.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b", name: "B", description: "", avatar: "/portrait.png", coverCrop: initialCrop, galleryCoverCrop: initialCrop, bannerImageUrl: banner } }));
    await f.click("overview.fromAssets"); const currentPicker = f.picker;
    await React.act(async () => { oldPicker.onSelect(banner); });
    assert.deepEqual(requests, []); assert.equal(f.store.getState().worldDraft.avatar, "/portrait.png");
    await React.act(async () => { currentPicker.onSelect(banner); currentPicker.onSelect(banner); currentPicker.onSelect(banner); });
    assert.deepEqual(requests, ["/api/worlds/world-b/thumbnail/from-asset"]);
    await f.click("Adjust crop"); const currentCrop = f.framing;
    const customCrop = { x: 8, y: 0, zoom: 0.7, fit: "cover" };
    await React.act(async () => oldCrop.onSave({ coverCrop: customCrop, galleryCoverCrop: customCrop }));
    assert.deepEqual(f.store.getState().worldDraft.coverCrop, initialCrop); assert.equal(f.saves, 0);
    await React.act(async () => currentCrop.onSave({ coverCrop: customCrop, galleryCoverCrop: customCrop }));
    assert.deepEqual(f.store.getState().worldDraft.coverCrop, customCrop); assert.equal(f.saves, 1); assert.equal(f.store.getState().worldDraft.bannerImageUrl, banner);
  } finally { globalThis.fetch = previousFetch; await f.close(); }
});


test("Overview cancels retained framing callbacks and saves only the active framing once", async () => {
  const f = await fixture("overview");
  try {
    const crop = { x: 9, y: 2, zoom: 0.5, fit: "cover" };
    const value = { coverCrop: crop, galleryCoverCrop: crop };
    await f.click("Adjust crop"); const canceled = f.framing;
    await React.act(async () => canceled.onCancel());
    await React.act(async () => canceled.onSave(value));
    assert.equal(f.saves, 0); assert.notDeepEqual(f.store.getState().worldDraft.coverCrop, crop);
    await f.click("Adjust crop"); const replaced = f.framing;
    await f.click("Adjust crop"); const active = f.framing;
    await React.act(async () => replaced.onSave(value)); assert.equal(f.saves, 0);
    await React.act(async () => { await active.onSave(value); await active.onSave(value); });
    assert.equal(f.saves, 1); assert.deepEqual(f.store.getState().worldDraft.coverCrop, crop);
  } finally { await f.close(); }
});
