import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getImageFilesFromTransfer } from "../lib/clipboard-image";
const require = createRequire(import.meta.url);
const React = require("react"), { JSDOM } = require("jsdom"), { transform } = require("sucrase");
type Context = { signal: AbortSignal; onProgress: (progress: { fraction: number; loaded: number; total: number; bytesPerSecond: number }) => void };
type Harness = { click: (label: string, twice?: boolean) => Promise<void>; source: (kind: string, files: File[]) => Promise<Event>; select: (files: File[]) => Promise<void>; render: () => Promise<void>; owner: (id: string) => void; prepared: () => number; closed: () => number; revoked: string[]; unmount: () => Promise<void> };
async function mounted(props: Record<string, unknown>, run: (h: Harness) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let owner = "alice", prepared = 0, closed = 0, sequence = 0, unmounted = false;
  const revoked: string[] = [], oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:test-${++sequence}`; URL.revokeObjectURL = url => { revoked.push(url); };
  const wrapper = ({ children, ...props }: { children: unknown; [key: string]: unknown }) => {
    const rest = { ...props };
    for (const key of ["open", "onOpenChange", "portalContainer", "overlayClassName", "onEscapeKeyDown"]) delete rest[key];
    return React.createElement("div", rest, children);
  };
  const prepare = props.testPrepare as ((source: File | string, signal: AbortSignal) => Promise<{ file: File; skipCrop: boolean }>) | undefined;
  const mocks: Record<string, unknown> = {
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: owner } }, isPending: false }) },
    "react-i18next": { useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }) },
    "@/components/ui/dialog": { Dialog: wrapper, DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper },
    "@/lib/clipboard-image": { getImageFilesFromTransfer },
    "@/lib/image-import": { MAX_IMAGE_IMPORT_BYTES: 20 * 1024 * 1024, prepareImportedImage: async (source: File | string, signal: AbortSignal) => { prepared++; if (prepare) return prepare(source, signal); return { file: typeof source === "string" ? new File(["validated"], "link.webp", { type: "image/webp" }) : new File(["normalized"], source.name + ".webp", { type: "image/webp" }), skipCrop: false }; } },
    "@/features/editor/components/sprite-crop-dialog": { SpriteCropDialog: ({ file, onConfirm }: { file: File; onConfirm: (file: File) => void }) => React.createElement("button", { onClick: () => onConfirm(file) }, "Confirm crop") },
  };
  const module = { exports: {} as { ImageImportDialog: unknown } };
  const code = transform(readFileSync(new URL("./image-import-dialog.tsx", import.meta.url), "utf8").replaceAll("import.meta.env", "({})"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  new Function("require", "module", "exports", code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const render = async () => React.act(async () => root.render(React.createElement(module.exports.ImageImportDialog, { onImport() {}, onClose: () => { closed++; }, ...props })));
  try {
    await render();
    await run({ render, owner: id => { owner = id; }, prepared: () => prepared, closed: () => closed, revoked,
      click: async (label, twice = false) => React.act(async () => { const node = [...document.querySelectorAll("button")].find(node => node.textContent === label); assert.ok(node, label); node.click(); if (twice) node.click(); }),
      select: async files => React.act(async () => { const input = document.querySelector('input[type="file"]')!; Object.defineProperty(input, "files", { configurable: true, value: files }); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }),
      source: async (kind, files) => { const e = new dom.window.Event(kind === "drop" ? "drop" : "paste", { bubbles: true, cancelable: true }); const data = { files: kind === "items" ? [] : files, items: files.map(file => ({ kind: "file", type: file.type, getAsFile: () => file })) }; Object.defineProperty(e, kind === "drop" ? "dataTransfer" : "clipboardData", { value: data }); await React.act(async () => document.querySelector('[aria-label="imageImport.paste"]')!.dispatchEvent(e)); return e; },
      unmount: async () => { await React.act(async () => root.unmount()); unmounted = true; },
    });
  } finally {
    if (!unmounted) await React.act(async () => root.unmount()); URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
}
const file = () => new File(["original bytes"], "group.png", { type: "image/png" });
test("native source previews original bytes and requires exactly one explicit confirmation", async () => {
  const original = file(); let files: File[] = [], calls = 0;
  await mounted({ title: "Page banner", description: "16:5 recommended", crop: "none", preserveOriginal: true, maxBytes: Infinity, onImport: (value: File[]) => { files = value; calls++; } }, async h => {
    await h.select([original]); assert.equal(h.prepared(), 0); assert.equal(calls, 0); assert.ok(document.querySelector('img[alt="group.png"]')); assert.match(document.body.textContent!, /16:5/);
    await h.click("Use image", true); assert.equal(calls, 1); assert.equal(files[0], original); assert.equal(await files[0]!.text(), "original bytes"); assert.equal(h.closed(), 1); assert.ok(h.revoked.length);
  });
});
test("ordinary local browse, paste and drop preserve originals without preparation or automatic crop", async () => {
  for (const kind of ["browse", "paste", "drop"]) {
    const original = file(); let imported: File | undefined;
    await mounted({ onImport: (files: File[]) => { imported = files[0]; } }, async h => {
      if (kind === "browse") await h.select([original]); else await h.source(kind, [original]);
      assert.equal(h.prepared(), 0, "local originals never make a normalize/download request");
      assert.equal([...document.querySelectorAll("button")].some(n => n.textContent === "Confirm crop"), false);
      assert.ok(document.querySelector('img[alt="group.png"]'));
      await h.click("Use image"); assert.equal(imported, original); assert.equal(await imported!.text(), "original bytes");
    });
  }
});
test("drop and clipboard items use shared preview while ordinary text paste is preserved", async () => {
  for (const kind of ["drop", "items"]) await mounted({ crop: "none", preserveOriginal: true }, async h => {
    assert.equal((await h.source("paste", [])).defaultPrevented, false);
    assert.equal((await h.source(kind, [file()])).defaultPrevented, true); assert.ok(document.querySelector('img[alt="group.png"]')); assert.equal(h.prepared(), 0);
    await h.click("Cancel"); assert.equal(h.closed(), 1); assert.equal(h.revoked.length, 1);
  });
});
test("caller count, format and size limits apply; native Infinity does not impose a new 20MiB cap", async () => {
  await mounted({ multiple: true, maxFiles: 1, maxBytes: 3, crop: "none", preserveOriginal: true }, async h => {
    for (const sources of [[file(), file()], [new File(["x"], "bad.svg", { type: "image/svg+xml" })], [file()]]) { await h.select(sources); assert.ok(document.querySelector('[role="alert"]')); assert.equal(h.prepared(), 0); assert.equal(document.querySelector("img"), null); }
  });
  await mounted({ maxBytes: Infinity, crop: "none", preserveOriginal: true }, async h => {
    await h.select([new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })]); assert.ok(document.querySelector("img")); assert.equal(h.prepared(), 0); assert.equal(document.querySelector('[role="alert"]'), null);
  });
});
test("upload context shows actual progress and aborts on close, unmount or account change", async () => {
  for (const ending of ["close", "unmount", "account"]) {
    const contexts: Context[] = []; let release!: () => void, calls = 0;
    await mounted({ crop: "none", preserveOriginal: true, onImport: (_files: File[], ctx: Context) => { calls++; contexts.push(ctx); return new Promise<void>(resolve => { release = resolve; }); } }, async h => {
      await h.select([file()]); await h.click("Use image", true); assert.equal(calls, 1); const ctx = contexts[0]!; assert.ok(ctx?.signal);
      await React.act(async () => ctx.onProgress({ fraction: 0.37, loaded: 37, total: 100, bytesPerSecond: 20 })); assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "37");
      if (ending === "close") await h.click("Cancel"); else if (ending === "unmount") await h.unmount(); else { h.owner("bob"); await h.render(); }
      assert.equal(ctx.signal.aborted, true); await React.act(async () => { release(); ctx.onProgress({ fraction: 1, loaded: 100, total: 100, bytesPerSecond: 20 }); }); assert.equal(h.closed(), ending === "unmount" ? 0 : 1); assert.ok(h.revoked.length);
    });
  }
});
test("destination errors retain preview for retry, and native URL sources still use validated preparation", async () => {
  let calls = 0;
  await mounted({ crop: "none", preserveOriginal: true, onImport: () => { calls++; if (calls === 1) throw Error("Destination unavailable"); } }, async h => {
    await h.select([file()]); await h.click("Use image"); assert.equal(h.closed(), 0); assert.match(document.querySelector('[role="alert"]')!.textContent!, /Destination unavailable/); await h.click("Use image"); assert.equal(calls, 2); assert.equal(h.closed(), 1);
  });
  await mounted({ crop: "none", preserveOriginal: true }, async h => {
    const area = document.querySelector("textarea")!; await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, "https://example.test/image.png"); area.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await h.click("imageImport.importLinks"); assert.equal(h.prepared(), 1); assert.ok(document.querySelector('img[alt="link.webp"]')); assert.equal(h.closed(), 0);
  });
});

test("closing during validated preparation aborts before a late prepared image can preview or import", async () => {
  const signals: AbortSignal[] = [];
  let release!: (value: { file: File; skipCrop: boolean }) => void, imported = 0;
  await mounted({ crop: "none", preserveOriginal: false, onImport: () => { imported++; }, testPrepare: (_source: unknown, signal: AbortSignal) => { signals.push(signal); return new Promise(resolve => { release = resolve; }); } }, async h => {
    await h.select([file()]); assert.equal(signals.length, 1); await h.click("Cancel"); assert.equal(signals[0]!.aborted, true);
    await React.act(async () => release({ file: file(), skipCrop: false })); assert.equal(imported, 0); assert.equal(document.querySelector("img"), null); assert.equal(h.closed(), 1);
  });
});
test("native uncapped multi-image actions preserve batches beyond the managed thirty-image default", async () => {
  await mounted({ multiple: true, maxFiles: Infinity, maxBytes: Infinity, preserveOriginal: true, crop: "none" }, async h => {
    await h.select(Array.from({ length: 31 }, file)); assert.equal(document.querySelectorAll("img").length, 31); assert.equal(document.querySelector('[role="alert"]'), null); assert.equal(h.prepared(), 0);
  });
});

test("managed destination failure retries the same prepared cropped batch without preparing or cropping again", async () => {
  const received: File[][] = [], contexts: Context[] = [];
  await mounted({ multiple: true, crop: "freeform", preserveOriginal: false, onImport: (files: File[], context: Context) => {
    received.push(files); contexts.push(context);
    if (received.length === 1) throw Error("Second destination upload failed");
  } }, async h => {
    await h.select([file(), new File(["second original"], "second.png", { type: "image/png" })]);
    await h.click("Confirm crop"); await h.click("Confirm crop");
    assert.equal(received.length, 1); assert.equal(h.prepared(), 2); assert.equal(h.closed(), 0);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Second destination upload failed/);
    assert.equal(document.querySelectorAll("img").length, 2, "failed prepared images remain available for retry");
    await h.click("Use images");
    assert.equal(received.length, 2); assert.equal(received[1], received[0]);
    assert.equal(received[1]![0], received[0]![0]); assert.equal(received[1]![1], received[0]![1]);
    assert.equal(contexts[0]!.signal, contexts[1]!.signal, "retry keeps the active operation cancellation signal");
    assert.equal(h.prepared(), 2); assert.equal(h.closed(), 1);
  });
});
