import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as math from "../../../lib/cropping";

const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");

test("Overview presents independent image slots with the actual card and detail preview ratios", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { create } = require("zustand");
  const store = create(() => ({ serverWorldId: "world-a", worldDraft: { id: "a", name: "Group story", description: "", avatar: "/portrait.png" }, galleryImages: [], readOnlyInspect: false, guestMode: false }));
  const mocks: Record<string, unknown> = {
    "@/components/image-import-dialog": {},
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "owner-a" } } }) },
    "@/stores/editor": { useEditorStore: store },
    "react-i18next": { useTranslation: () => ({ t: (key: string, opts?: { defaultValue: string }) => opts?.defaultValue ?? key }) },
    "@/components/ui/global-confirm-dialog": {}, "@/components/ui/select": { Select: (p: { children: unknown }) => React.createElement("select", null, p.children) },
    "@/components/ui/field-error": { FieldError: () => null }, "@/features/library/world-update-history": { WorldUpdateHistory: () => null },
    "@yumina/shared": { MAX_WORLD_NAME: 100, MAX_WORLD_DESCRIPTION: 10000 }, "@/lib/import-world": {}, "@/lib/asset-upload": {},
    "@/lib/cover-crop": { ...math, CroppedImage: (p: { alt: string; src: string; className: string }) => React.createElement("div", { "data-alt": p.alt, "data-src": p.src, className: p.className }) },
    "@/lib/world-cover-crop": { getWorldGalleryDisplayCrop: math.normalizeCoverCrop },
    "../asset-picker": {}, "../components/cover-crop-dialog": {}, "@/components/ui/two-tap-delete-button": {},
    "../components/page-banner-field": { PageBannerField: () => React.createElement("section", { "data-page-banner-field": true }, "Page banner") },
  };
  const module = { exports: {} as { OverviewSection: unknown } };
  const code = transform(readFileSync(new URL("./overview.tsx", import.meta.url), "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  try {
    await React.act(async () => root.render(React.createElement(module.exports.OverviewSection)));
    assert.ok(document.querySelector('[data-page-banner-field]'), "the banner field must be reachable from Overview");
    assert.match(document.body.textContent!, /Portrait card cover/);
    assert.ok(document.querySelector('[data-alt="Cover"]')!.parentElement!.classList.contains('aspect-[3/4]'));
    assert.ok(document.querySelector('[data-alt="Gallery preview"]')!.classList.contains('aspect-[16/5]'));
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
