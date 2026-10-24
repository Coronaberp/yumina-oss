import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { WorldItem } from "@/stores/worlds";

const url = new URL("./library-detail-panel.tsx", import.meta.url);
const require = createRequire(url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
const banner = "https://yumina.test/cdn/banner-asset";
const crop = { x: 0, y: 0, zoom: 1, fit: "contain" };

async function mounted(run: (context: { render: (item: WorldItem) => Promise<void>; seen: () => WorldItem; requests: string[]; release: (index: number, value: unknown) => Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previousFetch = globalThis.fetch;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.scrollTo = () => {};
  const requests: string[] = [], pending: Array<(value: unknown) => void> = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Promise(resolve => pending.push(value => resolve(Response.json({ data: value }))));
  };
  let selected!: WorldItem;
  const Detail = (props: { selectedItem: WorldItem }) => { selected = props.selectedItem; return React.createElement("div", { "data-banner": props.selectedItem.bannerImageUrl ?? "" }); };
  const mocks: Record<string, unknown> = {
    "@/hooks/use-media-query": { useMediaQuery: () => false },
    "./library-detail-panel-desktop": { LibraryDetailPanelDesktop: Detail },
    "./library-detail-panel-mobile": { LibraryDetailPanelMobile: Detail },
  };
  const module = { exports: {} as typeof import("./library-detail-panel") };
  const code = transform(readFileSync(url, "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const render = async (item: WorldItem) => React.act(async () => root.render(React.createElement(module.exports.LibraryDetailPanel, { selectedItem: item, allItems: [], onSelectItem() {}, onBack() {} })));
  try {
    await run({ render, seen: () => selected, requests, release: async (index, value) => React.act(async () => { pending[index]!(value); await new Promise(resolve => setImmediate(resolve)); }) });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
const item = (id: string, extra = {}): WorldItem => ({ id, name: id, schema: {}, thumbnailUrl: "/portrait.png", ...extra }) as WorldItem;

test("schema-free Library rows hydrate only banner display fields from existing preview", async () => {
  await mounted(async ({ render, seen, requests, release }) => {
    const original = item("one");
    await render(original);
    assert.deepEqual(requests, ["/api/worlds/one?preview=true"]);
    await release(0, { id: "one", bannerImageUrl: banner, bannerCrop: crop, thumbnailUrl: "/wrong.png", schema: { secret: true } });
    assert.equal(seen().bannerImageUrl, banner);
    assert.deepEqual(seen().bannerCrop, crop);
    assert.equal(seen().thumbnailUrl, "/portrait.png");
    assert.deepEqual(seen().schema, {});
    assert.equal(original.bannerImageUrl, undefined);
  });
});

test("late preview results cannot attach another world's banner", async () => {
  await mounted(async ({ render, seen, requests, release }) => {
    await render(item("one"));
    await render(item("two"));
    assert.equal(requests.length, 2);
    await release(0, { id: "one", bannerImageUrl: banner, bannerCrop: crop });
    assert.equal(seen().id, "two");
    assert.equal(seen().bannerImageUrl, undefined);
    await release(1, { id: "two", bannerImageUrl: "", bannerCrop: null });
    assert.equal(seen().bannerImageUrl, "");
    assert.equal(seen().bannerCrop, null);
  });
});

test("owned schema and explicit banner metadata render directly without preview requests", async () => {
  await mounted(async ({ render, seen, requests }) => {
    await render(item("owned", { schema: { bannerImageUrl: "@asset:123" } }));
    assert.equal(seen().schema.bannerImageUrl, "@asset:123");
    await render(item("clear", { bannerImageUrl: "" }));
    assert.equal(seen().bannerImageUrl, "");
    assert.equal(requests.length, 0);
  });
});
