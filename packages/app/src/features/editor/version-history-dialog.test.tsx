import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import { diffWorldSchemas } from "../../../../engine/src/diff/world-diff";
import type { WorldDefinition } from "@yumina/engine";

const draft = (name = "Current draft") => ({ id: "world", name, version: "20", entries: [], variables: [], rules: [], audioTracks: [], settings: {} }) as unknown as WorldDefinition;
const versions = ["one", "two"].map(id => ({ id, worldId: "world", name: `Saved ${id}`, createdBy: "owner", createdAt: new Date(), note: null }));
const detail = (name = "Saved one") => ({ data: { ...versions[0], schema: draft(name), thumbnailUrl: null, ageRating: "all" }, currentAgeRating: "all" });

test("comparison uses fresh unsaved drafts, loads on demand and closes without saving or restoring", async () => {
  await harness(async f => {
    assert.equal(f.requests.length, 1);
    await f.click("Compare with current draft");
    assert.equal(f.requests.at(-1), "/api/worlds/world/versions/one");
    assert.match(f.text(), /Saved version/);
    await act(async () => f.store.setState({ worldDraft: draft("Unsaved edit"), isDirty: true }));
    await f.settle(); assert.match(f.text(), /Unsaved edit/); assert.match(f.text(), /Includes unsaved edits/);
    await f.click("Back to history");
    await act(async () => f.store.setState({ worldDraft: draft("Reopened fresh") }));
    await f.click("Compare with current draft"); assert.match(f.text(), /Reopened fresh/);
    f.setReply(() => Response.json({ ...detail(), data: { ...detail().data, id: "two" } }));
    await f.select("two"); assert.equal(f.requests.at(-1), "/api/worlds/world/versions/two");
    await act(async () => f.store.setState({ worldDraft: draft("<img src=x onerror=alert(1)>") }));
    await f.settle(); assert.equal(f.document.querySelector("img"), null); assert.match(f.text(), /<img/);
    await act(async () => f.store.setState({ worldDraft: { ...draft(), description: "x".repeat(100_000) } }));
    await f.settle(); assert.ok(f.text().length < 25_000); assert.match(f.text(), /Show next/);
    await act(async () => f.document.defaultView!.dispatchEvent(new f.document.defaultView!.KeyboardEvent("keydown", { key: "Escape" })));
    assert.match(f.document.activeElement?.textContent ?? "", /Compare with current draft/);
    await f.click("Restore to draft"); assert.match(f.text(), /Restore this version to your draft/); assert.match(f.text(), /safety snapshot/);
    await f.click("Cancel");
  });
});

test("comparison handles no differences, failed/invalid snapshots, retry, and a different-world draft", async () => {
  await harness(async f => {
    f.setReply(() => Response.json(detail("Current draft")));
    await f.click("Compare with current draft"); assert.match(f.text(), /No differences/);
    await f.click("Back to history"); f.setReply(() => new Response(null, { status: 403 }));
    await f.click("Compare with current draft"); assert.match(f.text(), /Could not compare/);
    f.setReply(() => Response.json({ data: { schema: null } })); await f.click("Try again"); assert.match(f.text(), /Could not compare/);
    f.setReply(() => Response.json(detail())); await f.click("Try again"); assert.match(f.text(), /Saved one/);
    await act(async () => f.store.setState({ serverWorldId: "other" })); await f.settle();
    assert.match(f.text(), /Open this world/); assert.doesNotMatch(f.text(), /No differences/);
  });
});

test("switching cancels stale fetches and includes draft edits made during loading", async () => {
  await harness(async f => {
    let resolve!: (r: Response) => void;
    f.setReply(() => new Promise(r => { resolve = r; }));
    await f.click("Compare with current draft"); assert.match(f.text(), /Loading comparison/);
    await act(async () => f.store.setState({ worldDraft: draft("Edited while loading") }));
    f.setReply(() => Response.json({ ...detail("Saved two"), data: { ...detail("Saved two").data, id: "two" } }));
    await f.select("two"); assert.match(f.text(), /Edited while loading/);
    await act(async () => resolve(Response.json(detail("Stale content")))); await f.settle(); assert.doesNotMatch(f.text(), /Stale content/);
    await f.click("Back to history"); assert.match(f.text(), /Save a named version/);
  });
});

function createStore() { return create(() => ({ worldDraft: draft(), serverWorldId: "world" as string | null, isDirty: false, saveDraft: async () => { throw new Error("Comparison must never save"); }, loadWorld: async () => { throw new Error("Comparison must never restore"); } })); }
interface Fixture {
  click: (label: string) => Promise<void>; text: () => string; document: Document; select: (id: string) => Promise<void>;
  requests: string[]; store: ReturnType<typeof createStore>; settle: () => Promise<void>;
  setReply: (reply: () => Response | Promise<Response>) => void;
}
async function harness(run: (fixture: Fixture) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const store = createStore(); const requests: string[] = [];
  let reply: () => Response | Promise<Response> = () => Response.json(detail());
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { assert.ok(!init?.method || init.method === "GET"); requests.push(String(url)); return String(url).endsWith("/versions") ? Response.json({ data: versions }) : reply(); };
  const en = JSON.parse(readFileSync(new URL("../../locales/en/editor.json", import.meta.url), "utf8"));
  const t = (key: string, values?: Record<string, unknown>) => String(key.split(".").reduce((v, k) => v?.[k], en) ?? key).replace(/{{(\w+)}}/g, (_, k) => String(values?.[k] ?? k));
  const require = createRequire(import.meta.url);
  const modules: Record<string, unknown> = {
    "@/stores/editor": { useEditorStore: store }, "react-i18next": { useTranslation: () => ({ t, i18n: { language: "en" } }) },
    "../../../../engine/src/diff/world-diff": { diffWorldSchemas }, "@/lib/format-time": { formatTimeAgo: () => "just now" },
    "@/hooks/use-transient-flag": { useTransientFlag: () => false },
    "@/components/ui/checkbox": { Checkbox: () => createElement("input", { type: "checkbox" }) },
    "@/components/ui/field-error": { FieldError: () => null },
    "./version-comparison-client": { startVersionComparison: (input: unknown, done: (diff: unknown) => void) => {
      let cancelled = false; queueMicrotask(() => { if (!cancelled) done((load("./version-comparison-data.ts") as { compareVersionDraft: (input: unknown) => unknown }).compareVersionDraft(input)); });
      return () => { cancelled = true; };
    } },
  };
  function load(file: string): unknown {
    const module = { exports: {} }; const source = readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
    new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
      (id: string) => modules[id] ?? (id.startsWith("./") ? load(`${id}.tsx`) : require(id)), module, module.exports); return module.exports;
  }
  const { VersionHistoryDialog } = load("./version-history-dialog.tsx") as { VersionHistoryDialog: ComponentType<{ worldId: string; onClose: () => void }> };
  const root = createRoot(dom.window.document.getElementById("root")!); let closes = 0;
  const settle = async () => {
    await act(async () => { await new Promise(r => setTimeout(r, 180)); });
    await act(async () => {
      for (const summary of dom.window.document.querySelectorAll("details:not([open]) > summary")) (summary as HTMLElement).click();
      await new Promise(r => setTimeout(r, 10));
    });
  };
  const text = () => dom.window.document.body.textContent ?? "";
  const click = async (label: string) => { const button = [...dom.window.document.querySelectorAll("button")].find(b => b.textContent?.includes(label)); assert.ok(button, `Missing button ${label}: ${text().slice(0, 700)}`); await act(async () => button.click()); await settle(); };
  const select = async (id: string) => { const el = dom.window.document.querySelector("select")!; await act(async () => { el.value = id; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); await settle(); };
  try {
    await act(async () => root.render(createElement(VersionHistoryDialog, { worldId: "world", onClose: () => { closes++; } }))); await settle();
    await run({ click, text, document: dom.window.document, requests, store, settle, select, setReply: fn => { reply = fn; } }); assert.equal(closes, 0);
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = oldFetch; dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
