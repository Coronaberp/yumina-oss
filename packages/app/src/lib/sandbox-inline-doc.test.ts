import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { Rollup } from "vite";
import { inlineSandboxDocument } from "../../vite-plugins/sandbox-inline-doc";

function fixture(code = 'document.body.dataset.booted = "yes";'): Rollup.OutputBundle {
  return {
    "sandbox/index.html": {
      type: "asset", fileName: "sandbox/index.html",
      source: '<html><head><link rel="modulepreload" href="/assets/old.js"><link rel="stylesheet" href="/assets/style.css"></head><body><div id="sandbox-root"></div><script type="module" crossorigin src="/assets/runtime.js"></script></body></html>',
    },
    "assets/runtime.js": {
      type: "chunk", fileName: "assets/runtime.js", code, imports: [], dynamicImports: [],
    },
    "assets/style.css": { type: "asset", fileName: "assets/style.css", source: "body { color: red; }" },
  } as unknown as Rollup.OutputBundle;
}

test("sandbox document loads its complete JS and CSS without external requests", () => {
  const html = inlineSandboxDocument(fixture());
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelectorAll("script[src], link").length, 0);
  assert.equal(document.querySelector('script[type="module"]')?.textContent, 'document.body.dataset.booted = "yes";');
  assert.equal(document.querySelector("style")?.textContent, "body { color: red; }");
  assert.ok(document.querySelector("#sandbox-root"));
});

test("runtime strings containing closing tags cannot escape their HTML element", () => {
  const code = 'const value = "</ScRiPt><script>unexpected()</script>";';
  const { document } = new JSDOM(inlineSandboxDocument(fixture(code))).window;
  assert.equal(document.querySelectorAll("script").length, 1);
  const script = document.querySelector("script")!.textContent!;
  assert.ok(script.includes('<\\/script>'));
  assert.equal(new Function(`${script}; return value;`)(), "</ScRiPt><script>unexpected()</script>");
});

test("split runtime imports fail the build instead of silently needing anonymous asset requests", () => {
  for (const field of ["imports", "dynamicImports"] as const) {
    const bundle = fixture();
    const runtime = bundle["assets/runtime.js"];
    if (runtime.type !== "chunk") throw new Error("fixture");
    runtime[field] = ["assets/another.js"];
    assert.throws(() => inlineSandboxDocument(bundle), /no external imports/);
  }
});

test("unbundled scripts, styles and assets fail the build", () => {
  const unknownScript = fixture();
  const doc = unknownScript["sandbox/index.html"];
  if (doc.type !== "asset") throw new Error("fixture");
  doc.source = String(doc.source).replace("runtime.js", "missing.js");
  assert.throws(() => inlineSandboxDocument(unknownScript), /Unknown sandbox script/);
  const unknownStyle = fixture();
  delete unknownStyle["assets/style.css"];
  assert.throws(() => inlineSandboxDocument(unknownStyle), /Unknown sandbox stylesheet/);
  const externalAsset = fixture();
  externalAsset["assets/font.woff2"] = {
    type: "asset", fileName: "assets/font.woff2", source: new Uint8Array(),
  } as Rollup.OutputAsset;
  assert.throws(() => inlineSandboxDocument(externalAsset), /external asset/);
});
