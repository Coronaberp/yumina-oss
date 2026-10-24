import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import type { Asset } from "./assets";
import type { PresignedAssetUploadConfig, UploadProgress } from "../lib/asset-upload";

function load(upload: (config: PresignedAssetUploadConfig) => Promise<Asset>) {
  const source = new URL("./assets.ts", import.meta.url);
  const require = createRequire(source), module = { exports: {} as typeof import("./assets") };
  let errors = 0;
  const mocks: Record<string, unknown> = {
    "@/lib/asset-upload": { uploadAssetWithPresignedUrl: upload },
    "@/lib/feedback": { feedback: { error() { errors++; } } },
    "@/lib/i18n": { __esModule: true, default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } },
  };
  const code = transform(readFileSync(source, "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  return { store: module.exports.useAssetStore, errors: () => errors };
}
const file = new File(["pixels"], "group.png", { type: "image/png" });
const image = (worldId = "one"): Asset => ({ id: "asset-one", worldId, type: "image", filename: file.name, url: "/cdn/one", mimeType: file.type, sizeBytes: file.size, createdAt: "" });
const progress: UploadProgress = { fraction: 0.4, loaded: 4, total: 10, bytesPerSecond: 2 };

test("world uploads forward cancellation and actual progress while preserving legacy calls", async () => {
  const seen: PresignedAssetUploadConfig[] = [], events: UploadProgress[] = [];
  const { store, errors } = load(async config => { seen.push(config); config.onProgress?.(progress); return image(); });
  const controller = new AbortController();
  const result = await store.getState().uploadAsset("one", file, "image", { signal: controller.signal, onProgress: value => events.push(value), silent: true });
  assert.equal(result?.id, "asset-one"); assert.equal(seen[0]!.signal, controller.signal);
  assert.deepEqual(events, [progress]); assert.deepEqual(store.getState().uploadProgress, progress);
  assert.equal(store.getState().uploading, false); assert.equal(store.getState().uploadingCount, 0);
  assert.equal(store.getState().storage.used, file.size); assert.equal(errors(), 0);
  await store.getState().uploadAsset("one", file, "image");
  assert.equal(seen.length, 2, "existing three-argument uploads still work");
});

test("aborted or cleared world uploads cannot append late assets or report stale progress", async () => {
  let config!: PresignedAssetUploadConfig, complete!: (asset: Asset) => void;
  let starts = 0;
  const { store, errors } = load(value => { starts++; config = value; return new Promise(resolve => { complete = resolve; }); });
  const controller = new AbortController(), events: UploadProgress[] = [];
  const upload = store.getState().uploadAsset("one", file, "image", { signal: controller.signal, onProgress: value => events.push(value) });
  controller.abort(); config.onProgress?.(progress); complete(image());
  assert.equal(await upload, null); assert.equal(events.length, 0); assert.deepEqual(store.getState().assets, []); assert.equal(errors(), 0);
  const stale = store.getState().uploadAsset("one", file, "image", { onProgress: value => events.push(value) });
  store.getState().clear(); config.onProgress?.(progress); complete(image());
  assert.equal(await stale, null); assert.equal(events.length, 0); assert.deepEqual(store.getState().assets, []); assert.equal(store.getState().storage.used, 0); assert.equal(store.getState().uploadingCount, 0);
  const previousStarts = starts;
  const preaborted = await store.getState().uploadAsset("one", file, "image", { signal: controller.signal });
  assert.equal(preaborted, null); assert.equal(starts, previousStarts);
});

test("world fetch switches retire pending uploads without disturbing the new list", async () => {
  const original = globalThis.fetch;
  let complete!: (asset: Asset) => void;
  const { store } = load(() => new Promise(resolve => { complete = resolve; }));
  globalThis.fetch = async () => Response.json({ data: [image("two")] });
  try {
    const stale = store.getState().uploadAsset("one", file, "image");
    await store.getState().fetchAssets("two");
    complete(image("one")); assert.equal(await stale, null);
    assert.equal(store.getState().assets.length, 1); assert.equal(store.getState().assets[0]!.worldId, "two");
    assert.equal(store.getState().uploadingCount, 0);
  } finally { globalThis.fetch = original; }
});

test("silent failures stay in the calling dialog and ordinary failures retain their toast", async () => {
  const { store, errors } = load(async () => { throw new Error("storage failed"); });
  assert.equal(await store.getState().uploadAsset("one", file, "image", { silent: true }), null); assert.equal(errors(), 0);
  assert.equal(await store.getState().uploadAsset("one", file, "image"), null); assert.equal(errors(), 1);
  const controller = new AbortController(); controller.abort();
  assert.equal(await store.getState().uploadAsset("one", file, "image", { signal: controller.signal }), null); assert.equal(errors(), 1);
});
