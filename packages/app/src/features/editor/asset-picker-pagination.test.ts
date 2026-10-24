import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { transform } from "sucrase";
import type { AssetPicker } from "./asset-picker";
import type { useUserAssetStore } from "@/stores/user-assets";

for (const filterType of [undefined, "image"] as const) {
  test(`${filterType ?? "unfiltered"} picker starts at the first library page after browsing later pages`, async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const requests: URL[] = [];
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: string) => {
        const url = new URL(input, "https://yumina.test");
        requests.push(url);
        const data = url.searchParams.get("offset") === "0" ? [{ id: "first-cover", type: "image", filename: "first-cover.webp", url: "/cdn/first-cover" }] : [];
        return new Response(JSON.stringify({ data, total: 1 }));
      },
    };
    for (const [key, value] of Object.entries(globals)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    }
    const require = createRequire(import.meta.url);
    const load = (relative: string, mocks: Record<string, unknown>) => {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
      const module = { exports: {} as Record<string, unknown> };
      new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
        (id: string) => mocks[id] ?? require(id), module, module.exports,
      );
      return module.exports;
    };
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      const store = load("../../stores/user-assets.ts", {
        "@/lib/feedback": {}, "@/lib/i18n": {}, "@/lib/asset-upload": {},
      }).useUserAssetStore as typeof useUserAssetStore;
      store.setState({ page: 4 });
      const assets = { assets: [], loading: false, uploading: false, uploadingCount: 0, uploadProgress: null, fetchAssets: async () => {}, uploadAsset: async () => null };
      const picker = load("./asset-picker.tsx", {
        // Pagination does not open the independently tested image importer.
        "@/components/image-import-dialog": { ImageImportDialog: () => null },
        "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "owner" } } }) },
        "@/lib/utils": { cn: (...args: string[]) => args.join(" ") },
        "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
        "@/stores/assets": { useAssetStore: () => assets },
        "@/stores/user-assets": { useUserAssetStore: store },
        "@/lib/asset-upload": {},
        "@/lib/asset-url": { cardImageUrl: (url: string) => url, fallbackToOriginalOnError: () => {} },
      }).AssetPicker as typeof AssetPicker;
      await act(async () => root.render(createElement(picker, { worldId: "world", filterType, onSelect: () => {}, onClose: () => {} })));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.searchParams.get("offset"), "0");
      assert.equal(requests[0]!.searchParams.get("type"), filterType ?? null);
      assert.match(dom.window.document.body.textContent!, /first-cover.webp/);
    } finally {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
}
