import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("mounted import dialog binds its preview, blocks same-tick duplicate clicks and clears a rejected replacement file", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://test.invalid" });
  const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key] });
  let imports = 0, navigations = 0, closes = 0, parses = 0;
  let resolveImport: (value: { sessionId: string; worldId: string }) => void = () => {};
  let rejectImport: (error: Error) => void = () => {};
  let captured: { requestId?: string; contextSessionId?: string } | undefined;
  const payload = new Blob(['{"messages":[]}']);
  const requestId = crypto.randomUUID();
  const nativeRequire = createRequire(import.meta.url);
  const wrapper = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);
  const mocks: Record<string, unknown> = {
    "react": React,
    "lucide-react": { Download: wrapper, FileUp: wrapper, Loader2: wrapper },
    "@/components/ui/dialog": { Dialog: wrapper, DialogContent: wrapper, DialogDescription: wrapper, DialogHeader: wrapper, DialogTitle: wrapper },
    "./archive-client": { downloadSessionArchive: async () => {}, importArchive: async (body: Blob, options: typeof captured) => { imports++; captured = options; assert.equal(body, payload); return new Promise((resolve, reject) => { resolveImport = resolve; rejectImport = reject; }); } },
    "./archive-upload": { parseArchiveUpload: async () => { if (++parses === 2) throw new Error("Invalid archive JSON"); return { payload, requestId, preview: { sessionName: "Saved academy", worldName: "Academy", messageCount: 7, mode: "transcript" } }; } },
    "@/hooks/use-story-navigation": { useStoryNavigation: () => () => { navigations++; } },
    "@/stores/worlds": { useWorldsStore: { getState: () => ({ fetchWorlds: async () => {} }) } },
  };
  const source = readFileSync(new URL("./session-archive-dialog.tsx", import.meta.url), "utf8");
  const code = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code;
  const module = { exports: {} as { SessionArchiveDialog?: React.ComponentType<{ open: boolean; onClose: () => void; sessionId: string }> } };
  new Function("require", "module", "exports", code)((name: string) => mocks[name] ?? nativeRequire(name), module, module.exports);
  const Component = module.exports.SessionArchiveDialog!;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const choose = async () => {
    const input = dom.window.document.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [payload] });
    await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  };
  try {
    await act(async () => root.render(<Component open onClose={() => { closes++; }} sessionId="authorized-preview" />));
    await choose();
    assert.match(dom.window.document.body.textContent!, /7 messages · Transcript/);
    const button = Array.from(dom.window.document.querySelectorAll("button")).find(b => b.textContent === "Import as a new session")!;
    await act(async () => { button.click(); button.click(); });
    assert.equal(imports, 1); assert.deepEqual({ requestId: captured?.requestId, contextSessionId: captured?.contextSessionId }, { requestId, contextSessionId: "authorized-preview" });
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /Restoring/);
    await act(async () => { rejectImport(new Error("The import result could not be confirmed. Retry checks the same import.")); });
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /could not be confirmed/);
    assert.equal(dom.window.document.querySelector('[role="status"]'), null, "a terminal failure cannot retain active restoration progress");
    assert.equal(button.disabled, false);
    await act(async () => { button.click(); button.click(); });
    assert.equal(imports, 2, "the deliberate retry remains single-flight");
    assert.equal(captured?.requestId, requestId, "retry retains the original durable import attempt");
    await act(async () => { resolveImport({ sessionId: "restored", worldId: "same-card" }); });
    assert.equal(navigations, 1); assert.equal(closes, 1);
    await choose();
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Invalid archive JSON/);
    assert.ok(!dom.window.document.body.textContent!.includes("Import as a new session"));
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of globals) { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
