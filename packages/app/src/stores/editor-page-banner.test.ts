import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition } from "@yumina/engine";

const memory = new Map<string, string>();
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts`, "@yumina/shared": `${appRoot}/../shared/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { useWorldsStore } = await vite.ssrLoadModule("/src/stores/worlds.ts") as typeof import("./worlds");
const { feedback } = await vite.ssrLoadModule("/src/lib/feedback.tsx") as typeof import("../lib/feedback");
const { downloadWorldJSON, downloadWorldPNG } = await vite.ssrLoadModule("/src/lib/download-world.ts") as typeof import("../lib/download-world");
const { parseImportedFile } = await vite.ssrLoadModule("/src/lib/import-world.ts") as typeof import("../lib/import-world");
const initial = structuredClone(store.getState().worldDraft);
const registeredRef = "@asset:11111111-1111-4111-8111-111111111111";
const crop = { x: 0, y: 0, zoom: 1, fit: "contain" } as const;
const portraitCrop = { x: 4, y: -10, zoom: 0.8, fit: "cover" } as const;
const galleryCrop = { x: -2, y: 16, zoom: 0.7, fit: "cover" } as const;
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const schema = (): WorldDefinition => ({ ...structuredClone(initial), id: "banner-world", name: "Two image card", rootComponent: undefined,
  bannerImageUrl: registeredRef, bannerCrop: crop, coverCrop: portraitCrop, galleryCoverCrop: galleryCrop });
function load(value = schema()) {
  store.getState().loadWorldFromData({ id: "banner-world", name: value.name, description: null, thumbnailUrl: "/portrait.png", schema: value as unknown as Record<string, unknown> });
  store.setState({ baseUpdatedAt: "2026-10-23T12:00:00.000Z" });
}
beforeEach(t => {
  assert.ok("mock" in t);
  t.mock.method(feedback, "error", () => () => {});
  t.mock.method(feedback, "notice", () => () => {});
  t.mock.method(feedback, "persistent", () => () => {});
  t.mock.method(feedback, "progress", async (promise: Promise<unknown>) => await promise);
  t.mock.method(useWorldsStore.getState(), "invalidate", () => {});
  memory.clear();
  globalThis.fetch = async input => { throw new Error(`Unexpected network request ${String(input)}`); };
});
afterEach(() => { store.getState().stopAutosave(); globalThis.fetch = originalFetch; });
after(async () => { store.getState().stopAutosave(); await vite.close();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });

test("editor load and save preserve registered banner metadata independently of portrait and legacy crops", async () => {
  load();
  assert.equal(store.getState().worldDraft.bannerImageUrl, registeredRef);
  assert.deepEqual(store.getState().worldDraft.bannerCrop, crop);
  assert.equal(store.getState().worldDraft.avatar, "/portrait.png");
  store.getState().setField("bannerCrop", { x: 6, y: -3, zoom: 0.9, fit: "cover" });
  let submitted!: { schema: WorldDefinition & { avatar?: string } };
  globalThis.fetch = async (_url, init) => { assert.equal(init?.method, "PATCH"); submitted = JSON.parse(String(init?.body));
    return Response.json({ data: { id: "banner-world", updatedAt: "2026-10-23T12:01:00.000Z" } }); };
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(submitted.schema.bannerImageUrl, registeredRef);
  assert.deepEqual(submitted.schema.bannerCrop, { x: 6, y: -3, zoom: 0.9, fit: "cover" });
  assert.deepEqual(submitted.schema.coverCrop, portraitCrop);
  assert.deepEqual(submitted.schema.galleryCoverCrop, galleryCrop);
  assert.equal("avatar" in submitted.schema, false, "portrait stays in thumbnail storage");
  load(submitted.schema);
  assert.deepEqual(store.getState().worldDraft.bannerCrop, submitted.schema.bannerCrop);
  store.getState().setField("bannerImageUrl", "");
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(submitted.schema.bannerImageUrl, "", "explicit remove survives schema writes");
  assert.equal(store.getState().worldDraft.avatar, "/portrait.png");
});

test("native JSON and PNG download/import retain registered banner refs and independent framing", async t => {
  const saved = schema(), blobs: Blob[] = [];
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ click() {} }) } });
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { blobs.push(blob); return "blob:test-export"; });
  t.mock.method(URL, "revokeObjectURL", () => {});
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input));
    if (String(input) === "/portrait.png") return new Response(TINY_PNG, { headers: { "Content-Type": "image/png" } });
    assert.equal(String(input), "/api/worlds/banner-world?forEdit=1");
    return Response.json({ data: { id: "banner-world", schema: saved, name: saved.name, thumbnailUrl: "/portrait.png" } }); };
  try {
    await downloadWorldJSON("banner-world"); await downloadWorldPNG("banner-world");
    assert.equal(blobs.length, 2);
    for (const [index, type] of ["application/json", "image/png"].entries()) {
      const file = new File([await blobs[index]!.arrayBuffer()], index ? "card.png" : "card.json", { type });
      const imported = await parseImportedFile(file, { sourceHint: "yumina" });
      assert.equal(imported.world.bannerImageUrl, registeredRef);
      assert.deepEqual(imported.world.bannerCrop, crop);
      assert.deepEqual(imported.world.coverCrop, portraitCrop);
      assert.deepEqual(imported.world.galleryCoverCrop, galleryCrop);
    }
    assert.deepEqual(requests, ["/api/worlds/banner-world?forEdit=1", "/api/worlds/banner-world?forEdit=1", "/portrait.png"], "banner stays metadata; export does not fetch/embed banner binaries");
  } finally { if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else Reflect.deleteProperty(globalThis, "document"); }
});
