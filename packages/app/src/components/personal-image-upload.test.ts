import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, createElement, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

interface ImportProps {
  onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>;
  onClose: () => void;
  crop?: string;
  preserveOriginal?: boolean;
  maxBytes?: number;
  maxFiles?: number;
}
const require = createRequire(import.meta.url);
const file = new File(["image"], "image.png", { type: "image/png" });
const shell = ({ children }: { children?: ReactNode }) => createElement("div", null, children);

async function mounted() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const click = async (label: string) => act(async () => {
    const button = [...document.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
    assert.ok(button, `Missing ${label}`); button.click();
  });
  return { dom, root, click, cleanup: async () => { await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of descriptors) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } } };
}

function load<T>(url: URL, mocks: Record<string, unknown>): T {
  const module = { exports: {} as T };
  const source = readFileSync(url, "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => mocks[id] ?? require(id), module, module.exports);
  return module.exports;
}

test("profile avatar uses the common dialog, cancels late uploads, and keeps failures retryable", async () => {
  const ui = await mounted(); let importer: ImportProps | null = null;
  let finish!: (asset: { url: string; key?: string } | null) => void;
  let refreshes = 0, defer = true;
  let nextAsset: { url: string; key?: string } | null = null;
  const uploads: unknown[][] = [], patches: { init?: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => { patches.push({ init }); return Response.json({}); };
  const { ProfileIdentityHeader } = load<{ ProfileIdentityHeader: React.ComponentType }>(new URL("../features/account/sections/profile-identity-header.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/image-import-dialog": { ImageImportDialog: (props: ImportProps) => { importer = props; return createElement("div", { "data-import": "profile" }); } },
    "@/stores/user-profile": { useUserProfileStore: () => ({ profile: { id: "alice", name: "Alice" }, forceFetchProfile: async () => { refreshes++; } }) },
    "@/stores/user-assets": { useUserAssetStore: (selector: (value: unknown) => unknown) => selector({ uploadAsset: (...args: unknown[]) => { uploads.push(args); return defer ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(nextAsset); } }) },
    "@/components/ui/avatar": { Avatar: shell, AvatarFallback: shell, AvatarImage: () => null },
    "@/components/ui/field-error": { FieldError: ({ message }: { message?: string }) => message ? createElement("div", { role: "alert" }, message) : null },
    "@/lib/asset-url": { resolveImageUrl: () => null },
    "@/lib/avatar-initials": { getAvatarInitials: () => "A" },
  });
  try {
    await act(async () => ui.root.render(createElement(ProfileIdentityHeader)));
    await ui.click("editModal.change");
    assert.ok(importer, "avatar must stage the shared image dialog before uploading");
    const staged = importer as ImportProps;
    assert.equal(uploads.length, 0); assert.equal(staged.crop, "none"); assert.equal(staged.preserveOriginal, true); assert.equal(staged.maxBytes, Infinity);
    const controller = new AbortController(); let pending!: Promise<void>;
    await act(async () => { pending = staged.onImport([file], { signal: controller.signal, onProgress() {} }); });
    assert.equal((uploads[0]![3] as { signal: AbortSignal }).signal, controller.signal);
    await act(async () => { controller.abort(); staged.onClose(); finish({ url: "/late.png" }); await pending; });
    assert.equal(patches.length, 0, "a cancelled upload must not PATCH the avatar"); assert.equal(refreshes, 0);
    defer = false;
    await ui.click("editModal.change");
    const active = importer as ImportProps;
    await act(async () => { await assert.rejects(active.onImport([file], { signal: new AbortController().signal, onProgress() {} }), /avatarUploadFailed/); });
    assert.ok(document.querySelector("[data-import]"), "failed destination upload stays available for retry");
    assert.equal(patches.length, 0);
    nextAsset = { url: "/avatar.png", key: "avatars/alice.png" };
    const retryContext = { signal: new AbortController().signal, onProgress() {} };
    await act(async () => active.onImport([file], retryContext));
    assert.equal(patches.length, 1, "retry after known failure must still apply to this avatar");
    assert.deepEqual(JSON.parse(String(patches[0]!.init!.body)), { image: "avatars/alice.png" });
    assert.equal(refreshes, 1);
    await act(async () => active.onImport([file], retryContext));
    assert.equal(patches.length, 1, "a completed dialog callback must not apply the image twice");
  } finally { globalThis.fetch = originalFetch; await ui.cleanup(); }
});

test("report screenshots use the common dialog with four slots and ten-MiB files before submitting existing keys", async () => {
  const ui = await mounted(); let importer: ImportProps | null = null;
  const requests: { path: string; init?: RequestInit }[] = [], originalFetch = globalThis.fetch;
  let deferUpload = false; let finishPresign!: (value: Response) => void;
  globalThis.fetch = async (input, init) => {
    const path = String(input); requests.push({ path, init });
    if (path.endsWith("/report/mine")) return Response.json({ data: { reported: false } });
    if (path.endsWith("/upload-screenshot") && deferUpload) return new Promise(resolve => { finishPresign = resolve; });
    if (path.endsWith("/upload-screenshot")) return Response.json({ data: { key: "screenshot-key", uploadUrl: "https://storage.test/upload" } });
    return Response.json({});
  };
  const { ReportDialog } = load<{ ReportDialog: React.ComponentType<{ worldId: string; targetName: string; open: boolean; onClose: () => void }> }>(new URL("./report-dialog.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/image-import-dialog": { ImageImportDialog: (props: ImportProps) => { importer = props; return createElement("div", { "data-import": "report" }); } },
    "@/components/ui/field-error": { FieldError: () => null }, "@/lib/feedback": { feedback: { error() {} } },
  });
  try {
    await act(async () => ui.root.render(createElement(ReportDialog, { worldId: "world", targetName: "Card", open: true, onClose() {} })));
    await act(async () => {
      const trigger = [...document.querySelectorAll("span")].find(node => node.textContent === "report.dragHere")?.parentElement;
      assert.ok(trigger); trigger.click();
    });
    assert.ok(importer, "report image button must stage the shared dialog");
    const staged = importer as ImportProps;
    assert.equal(staged.crop, "none"); assert.equal(staged.preserveOriginal, true); assert.equal(staged.maxFiles, 4); assert.equal(staged.maxBytes, 10 * 1024 * 1024);
    assert.equal(requests.filter(row => row.path.endsWith("/upload-screenshot")).length, 0);
    const controller = new AbortController();
    await act(async () => staged.onImport([file], { signal: controller.signal, onProgress() {} }));
    assert.equal(requests.find(row => row.path.endsWith("/upload-screenshot"))!.init!.signal, controller.signal);
    assert.equal(requests.find(row => row.path.startsWith("https://storage"))!.init!.signal, controller.signal);
    await act(async () => staged.onClose());
    await act(async () => [...document.querySelectorAll("span")].find(node => node.textContent === "report.dragHere")!.parentElement!.click());
    const cancelled = importer as ImportProps;
    assert.equal(cancelled.maxFiles, 3, "the next import preserves remaining screenshot slots");
    deferUpload = true; const cancelController = new AbortController(); let pending!: Promise<void>;
    await act(async () => { pending = cancelled.onImport([file], { signal: cancelController.signal, onProgress() {} }); });
    await act(async () => { cancelController.abort(); cancelled.onClose(); finishPresign(Response.json({ data: { key: "late-key", uploadUrl: "https://storage.test/late" } })); await pending; });
    assert.equal(requests.filter(row => row.path.startsWith("https://storage")).length, 1, "cancelled report import must not begin the later storage upload");
    await ui.click("report.reasons.illegalContent"); await ui.click("report.submit");
    const submitted = requests.find(row => row.path.endsWith("/report"))!;
    assert.deepEqual(JSON.parse(String(submitted.init!.body)).screenshotKeys, ["screenshot-key"]);
  } finally { globalThis.fetch = originalFetch; await ui.cleanup(); }
});

test("wallpaper upload uses the common dialog and forwards its cancellation context", async () => {
  const ui = await mounted(); let importer: ImportProps | null = null;
  const settings = readFileSync(new URL("../features/settings/settings-page.tsx", import.meta.url), "utf8");
  const source = settings.slice(settings.indexOf("function WallpaperSection("), settings.indexOf("function WallpaperSlider("));
  const noop = () => null, modules: Record<string, unknown> = {
    react: React,
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/image-import-dialog": { ImageImportDialog: (props: ImportProps) => { importer = props; return createElement("div", { "data-import": "wallpaper" }); } },
  };
  const prelude = 'const {useState,useRef,useEffect}=require("react"); const {useTranslation}=require("react-i18next"); const {ImageImportDialog}=require("@/components/image-import-dialog");';
  const module = { exports: {} as { WallpaperSection: React.ComponentType<Record<string, unknown>> } };
  new Function("require", "module", "exports", "Card", "CardIcon", "SectionHeader", "WallpaperSlider", "ImageIcon", "Upload", "Loader2", "buildWallpaperOptions",
    transform(prelude + source + ";module.exports={WallpaperSection}", { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports, shell, noop, noop, noop, noop, noop, noop, () => []);
  const uploads: unknown[][] = [];
  try {
    await act(async () => ui.root.render(createElement(module.exports.WallpaperSection, {
      wallpaperAssets: [], wallpaperFolderName: "wallpaper", wallpaperAssetsLoading: false, wallpaperUploading: false,
      onUploadWallpaper: async (...args: unknown[]) => { uploads.push(args); },
    })));
    await ui.click("wallpaper.upload.button"); assert.ok(importer, "wallpaper upload must open the common dialog");
    const staged = importer as ImportProps;
    assert.equal(staged.crop, "none"); assert.equal(staged.preserveOriginal, true); assert.equal(staged.maxBytes, Infinity);
    assert.equal(uploads.length, 0);
    const context = { signal: new AbortController().signal, onProgress() {} };
    await act(async () => staged.onImport([file], context));
    assert.equal(uploads[0]![0], file); assert.equal(uploads[0]![1], context);
    await act(async () => staged.onImport([file], context));
    assert.equal(uploads.length, 1, "a completed wallpaper import callback is retired");
  } finally { await ui.cleanup(); }
});

test("wallpaper upload stops before destination upload after cancellation", async () => {
  const source = readFileSync(new URL("../features/settings/settings-page.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const handleWallpaperUpload = async");
  const handler = source.slice(start, source.indexOf("  const handleSaveUsername =", start));
  let finish!: (folder: string) => void;
  let uploads = 0, fetches = 0;
  const owner = { current: "alice" };
  const module = { exports: {} as { handleWallpaperUpload: (file: File, context: { signal: AbortSignal; onProgress: () => void }) => Promise<void> } };
  new Function("module", "ensureWallpaperFolder", "uploadAsset", "fetchAssets", "wallpaperOwner", "t", transform(handler + ";module.exports={handleWallpaperUpload}", { transforms: ["typescript"] }).code)(
    module, () => new Promise(resolve => { finish = resolve; }), async () => { uploads++; return {}; }, async () => { fetches++; }, owner, (key: string) => key);
  const controller = new AbortController();
  const pending = module.exports.handleWallpaperUpload(file, { signal: controller.signal, onProgress() {} });
  controller.abort(); finish("wallpaper-folder"); await pending;
  assert.equal(uploads, 0, "cancel during folder preparation must not begin an image upload"); assert.equal(fetches, 0);
  const afterAccountChange = module.exports.handleWallpaperUpload(file, { signal: new AbortController().signal, onProgress() {} });
  owner.current = "bob"; finish("other-folder"); await afterAccountChange;
  assert.equal(uploads, 0, "a changed account must not receive the pending wallpaper upload");
});
