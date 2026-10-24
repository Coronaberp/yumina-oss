import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { ComponentType } from "react";

const sourceUrl = new URL("./world-detail-media.ts", import.meta.url);
const require = createRequire(sourceUrl);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
function load() {
  const module = { exports: {} as typeof import("./world-detail-media") };
  new Function("require", "module", "exports", transform(readFileSync(sourceUrl, "utf8"), { transforms: ["typescript", "imports"] }).code)(require, module, module.exports);
  return module.exports;
}

test("detail media gives an independent banner full-art fitting while legacy crops remain unchanged", () => {
  const { resolveWorldDetailMedia, normalizeWorldBannerCrop } = load();
  assert.deepEqual(normalizeWorldBannerCrop(undefined), { x: 0, y: 0, zoom: 1, fit: "contain" });
  assert.deepEqual(normalizeWorldBannerCrop({ x: 3 }), { x: 3, y: 0, zoom: 1, fit: "contain" });
  const item = { id: "a", thumbnailUrl: "portrait.png", galleryCoverCrop: { x: 5, y: -3, zoom: 0.7, fit: "contain" as const }, schema: {} };
  assert.deepEqual(resolveWorldDetailMedia(item, "desktop"), { src: "portrait.png", hasBanner: false, crop: { x: 5, y: -3, zoom: 0.7, fit: "cover" } });
  assert.deepEqual(resolveWorldDetailMedia(item, "mobile"), { src: "portrait.png", hasBanner: false, crop: undefined });
  const banner = { ...item, bannerImageUrl: "@asset:group" };
  assert.deepEqual(resolveWorldDetailMedia(banner, "desktop"), { src: "@asset:group", hasBanner: true, crop: { x: 0, y: 0, zoom: 1, fit: "contain" } });
  assert.deepEqual(resolveWorldDetailMedia(banner, "mobile"), resolveWorldDetailMedia(banner, "desktop"));
  assert.equal(item.thumbnailUrl, "portrait.png");
  assert.deepEqual(resolveWorldDetailMedia({ ...banner, bannerCrop: { x: 9, y: -4, zoom: 0.8, fit: "cover" as const } }, "mobile").crop, { x: 9, y: -4, zoom: 0.8, fit: "cover" });
});

test("schema banners support local drafts while explicit cleared DTO metadata wins", () => {
  const { resolveWorldDetailMedia } = load();
  const item = { id: "a", thumbnailUrl: "portrait.png", schema: { bannerImageUrl: "@asset:group", bannerCrop: { x: 1, y: 2, zoom: 0.8, fit: "contain" } } };
  assert.equal(resolveWorldDetailMedia(item, "desktop").src, "@asset:group");
  assert.equal(resolveWorldDetailMedia({ ...item, bannerImageUrl: "" }, "desktop").src, "portrait.png");
  assert.equal(resolveWorldDetailMedia({ ...item, bannerImageUrl: null }, "desktop").src, "portrait.png");
});

test("mounted detail media falls back once, resets for source/world switches, and ignores stale errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { useWorldDetailMedia } = load();
  const { createRoot } = require("react-dom/client");
  const mounted = createRoot(document.getElementById("root"));
  let staleError = () => {};
  function Harness({ item }: { item: { id: string; thumbnailUrl: string; bannerImageUrl: string; schema: Record<string, unknown> } }) {
    const media = useWorldDetailMedia(item, "mobile");
    React.useEffect(() => { staleError = media.onError; }, [media.onError]);
    return React.createElement("section", { "data-banner": media.hasBanner }, media.src ? React.createElement("img", { src: media.src, alt: "hero", onError: media.onError }) : React.createElement("span", null, "Missing"));
  }
  const render = async (id: string, banner: string, portrait = "portrait.png") => React.act(async () => mounted.render(React.createElement(Harness as ComponentType, { item: { id, thumbnailUrl: portrait, bannerImageUrl: banner, schema: {} } })));
  const fail = async () => React.act(async () => document.querySelector("img")!.dispatchEvent(new dom.window.Event("error")));
  try {
    await render("a", "group.png");
    assert.equal(document.querySelector("img")?.getAttribute("src"), "group.png");
    const oldError = staleError;
    await fail();
    assert.equal(document.querySelector("img")?.getAttribute("src"), "portrait.png");
    assert.equal(document.querySelector("section")?.getAttribute("data-banner"), "false");
    await fail();
    assert.equal(document.querySelector("img"), null);
    await render("a", "new.png");
    assert.equal(document.querySelector("img")?.getAttribute("src"), "new.png");
    await React.act(async () => oldError());
    assert.equal(document.querySelector("img")?.getAttribute("src"), "new.png");
    await fail();
    assert.equal(document.querySelector("img")?.getAttribute("src"), "portrait.png");
    await render("b", "new.png");
    assert.equal(document.querySelector("img")?.getAttribute("src"), "new.png");
    await render("b", "");
    assert.equal(document.querySelector("img")?.getAttribute("src"), "portrait.png");
  } finally {
    await React.act(async () => mounted.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("desktop and mobile detail heroes consume banner media while custom showcases keep the portrait", () => {
  for (const layout of ["desktop", "mobile"]) {
    const source = readFileSync(new URL(`../features/library/library-detail-panel-${layout}.tsx`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`useWorldDetailMedia\\(selectedItem, "${layout}"\\)`));
    assert.equal(source.match(/src=\{heroMedia\.src\}/g)?.length, 2, "normal and orphaned heroes share fallback behavior");
    assert.equal(source.match(/onError=\{heroMedia\.onError\}/g)?.length, 2);
    assert.match(source, /heroMedia\.hasBanner\s*\?\s*"[^"]*aspect-\[16\/5\][^"]*"/);
    assert.match(source, /<PublishedCardShowcase[\s\S]*cover=\{selectedItem\.thumbnailUrl\}/);
  }
});
