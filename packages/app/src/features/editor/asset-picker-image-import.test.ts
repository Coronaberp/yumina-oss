import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");

test("asset image import forwards cancellation/progress, retains failures and rejects stale selections", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let owner = "owner", world = "world-a", fail = false;
  let resolveUpload!: (value: unknown) => void;
  const options: Array<{ signal?: AbortSignal; onProgress?: unknown; silent?: boolean }> = [];
  const selected: string[] = [];
  const noop = () => {};
  let importer!: { onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>; onClose: () => void };
  const assets = { assets: [], loading: false, uploading: false, uploadingCount: 0, uploadProgress: null, fetchAssets: noop,
    uploadAsset: async (_world: string, _file: File, _type: string, value: typeof options[number]) => { options.push(value); return fail ? null : new Promise(resolve => { resolveUpload = resolve; }); } };
  const module = { exports: {} as { AssetPicker: unknown } };
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/assets": { useAssetStore: () => assets },
    "@/stores/user-assets": { useUserAssetStore: () => ({ assets: [], loading: false, fetchAssets: noop }) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: owner } }, isPending: false }) },
    "@/lib/asset-upload": { getUploadMetadata: () => ({ type: "image" }) },
    "@/lib/asset-url": {}, "@/lib/utils": { cn: (...values: unknown[]) => values.join(" ") },
    "@/components/image-import-dialog": { ImageImportDialog: (props: typeof importer) => { importer = props; return React.createElement("div", { "data-import": true }); } },
  };
  const code = transform(readFileSync(new URL("./asset-picker.tsx", import.meta.url), "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const render = () => root.render(React.createElement(module.exports.AssetPicker, { worldId: world, filterType: "image", onSelect: (ref: string) => selected.push(ref), onClose: noop }));
  const open = async () => React.act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "Upload")!.click(); });
  const file = new File(["png"], "source.png", { type: "image/png" });
  try {
    await React.act(async () => render()); await open();
    const controller = new AbortController(), progress = noop;
    let pending!: Promise<void>;
    await React.act(async () => { pending = importer.onImport([file], { signal: controller.signal, onProgress: progress }); });
    assert.equal(options[0]?.onProgress, progress);
    assert.equal(options[0]?.silent, true);
    controller.abort();
    await React.act(async () => { resolveUpload({ id: "late" }); await assert.rejects(pending); });
    assert.deepEqual(selected, [], "cancelled import cannot select an uploaded result");
    fail = true;
    await React.act(async () => { await assert.rejects(importer.onImport([file], { signal: new AbortController().signal, onProgress: noop })); });
    assert.ok(document.querySelector("[data-import]"), "failed image import stays open");
    fail = false;
    await React.act(async () => { pending = importer.onImport([file], { signal: new AbortController().signal, onProgress: noop }); });
    await React.act(async () => { resolveUpload({ id: "retried" }); await pending; importer.onClose(); });
    assert.deepEqual(selected, ["@asset:retried"], "retry after a failed upload selects its successful result once");
    await open();
    await React.act(async () => { pending = importer.onImport([file], { signal: new AbortController().signal, onProgress: noop }); });
    world = "world-b"; owner = "other"; await React.act(async () => render());
    await React.act(async () => { resolveUpload({ id: "wrong-world" }); await assert.rejects(pending); });
    assert.deepEqual(selected, ["@asset:retried"]);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
