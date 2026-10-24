import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as cropMath from "../../../lib/cropping";

const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
const full = { x: 0, y: 0, zoom: 1, fit: "contain" };

test("banner crop dialog starts with full artwork and saves independent fill framing", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  dom.window.scrollTo = () => {};
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "react-image-crop": { __esModule: true, default: (props: { children: unknown; aspect: number; onChange: (value: unknown, percent: unknown) => void }) => React.createElement("div", { "data-crop-aspect": props.aspect }, props.children, React.createElement("button", { onClick: () => props.onChange({}, { unit: "%", x: 10, y: 20, width: 70, height: 20 }) }, "Move crop")) },
    "react-image-crop/dist/ReactCrop.css": {},
    "@/lib/world-detail-media": { DEFAULT_WORLD_BANNER_CROP: full, normalizeWorldBannerCrop: (value: unknown) => value ?? full },
    "@/lib/world-cover-crop": { getWorldGalleryDisplayCrop: (value: unknown) => ({ ...cropMath.normalizeCoverCrop(value), fit: "cover" }) },
    "@/lib/cover-crop": { ...cropMath, CroppedImage: (props: { src: string; crop: unknown; className: string }) => React.createElement("div", { "data-preview": props.src, "data-crop": JSON.stringify(props.crop), className: props.className }) },
    "@/lib/asset-url": { resolveImageUrl: (ref: string) => ref },
  };
  const module = { exports: {} as { CoverCropDialog: unknown } };
  const code = transform(readFileSync(new URL("./cover-crop-dialog.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const mounted = require("react-dom/client").createRoot(document.getElementById("root"));
  type CropSave = { bannerCrop?: unknown; coverCrop?: unknown };
  const saved: { current: CropSave | null } = { current: null };
  const click = async (text: string) => React.act(async () => { const node = [...document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, text); node.click(); });
  try {
    await React.act(async () => mounted.render(React.createElement(module.exports.CoverCropDialog, { src: "/wide.png", variant: "banner", initialBannerCrop: full, onCancel() {}, onSave: (value: CropSave) => { saved.current = value; } })));
    assert.match(document.body.textContent!, /Page banner framing/);
    assert.doesNotMatch(document.body.textContent!, /Card cover|Gallery preview/);
    assert.equal(document.querySelector('[data-crop-aspect]'), null, "full-art fit does not imply a cropped-away area");
    assert.deepEqual(JSON.parse(document.querySelector('[data-preview]')!.getAttribute('data-crop')!), full);
    await click("Save banner framing"); assert.deepEqual(saved.current?.bannerCrop, full);
    await click("Crop to fill"); assert.equal(document.querySelector('[data-crop-aspect]')!.getAttribute('data-crop-aspect'), String(16 / 5));
    await click("Move crop"); await click("Save banner framing"); assert.equal((saved.current?.bannerCrop as { fit: string }).fit, "cover");
    await click("Fit full image"); await click("Save banner framing"); assert.deepEqual(saved.current?.bannerCrop, full);
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
