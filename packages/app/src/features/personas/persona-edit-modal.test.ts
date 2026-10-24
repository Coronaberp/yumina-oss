import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("existing persona editor adds, saves, reloads and removes custom entries without changing Backstory", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  let saved = { id: "persona", name: "Alex", backstory: "Keep this story", entries: [] as { title: string; content: string }[] };
  let saves = 0, uploads = 0, deferUpload = false;
  let finishUpload!: (asset: { url: string }) => void;
  type PersonaImageImport = { onImport: (files: File[], context: { signal: AbortSignal; onProgress: () => void }) => Promise<void>; onClose: () => void; crop?: string; preserveOriginal?: boolean; maxBytes?: number };
  let imageImport: PersonaImageImport | null = null;
  const shell = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/image-import-dialog": { ImageImportDialog: (props: PersonaImageImport) => { imageImport = props; return createElement("button", { id: "confirm-import", onClick: () => props.onImport([new File(["image"], "normal.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress() {} }) }, "Confirm image"); } },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", null, children) : null, DialogContent: shell, DialogTitle: shell },
    "@/components/ui/input": { Input: (props: Record<string, unknown>) => createElement("input", props) },
    "@/components/ui/button": { Button: (props: Record<string, unknown>) => { const native = { ...props }; delete native.variant; return createElement("button", native); } },
    "@/components/ui/field-error": { FieldError: ({ message }: { message?: string }) => message ? createElement("div", { role: "alert" }, message) : null },
    "@/stores/personas": { usePersonasStore: () => ({ updatePersona: async (_: string, input: Partial<typeof saved>) => { saves++; saved = { ...saved, ...input }; return saved; } }) },
    "@/stores/user-assets": { useUserAssetStore: () => ({ uploadAsset: async () => { uploads++; return deferUpload ? new Promise(resolve => { finishUpload = resolve; }) : { url: "https://cdn.example/normal.png" }; } }) },
    "@/lib/asset-url": { resolveImageUrl: () => null },
  };
  const module = { exports: {} as { PersonaEditModal: ComponentType<{ isOpen: boolean; onClose: () => void; persona: typeof saved }> } };
  const source = readFileSync(new URL("./persona-edit-modal.tsx", import.meta.url), "utf8");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports,
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (isOpen: boolean) => root.render(createElement(module.exports.PersonaEditModal, { isOpen, persona: saved, onClose() {} }));
  const button = (text: string) => [...dom.window.document.querySelectorAll("button")].find(element => element.textContent?.includes(text))!;
  async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => render(true));
    for (const expression of ["normal", "happy", "sad", "angry", "shy", "smug"]) {
      assert.ok(dom.window.document.querySelector(`button[aria-label="Upload ${expression} sprite"]`), `missing ${expression} sprite upload`);
    }
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Upload normal sprite"]')!.click());
    assert.ok(imageImport, "sprite upload must open the common image dialog before changing the persona");
    assert.equal((imageImport as PersonaImageImport).crop, "none");
    assert.equal((imageImport as PersonaImageImport).preserveOriginal, true);
    assert.equal((imageImport as PersonaImageImport).maxBytes, Infinity);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("#confirm-import")!.click());
    await act(async () => (imageImport as PersonaImageImport).onImport([new File(["image"], "normal.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress() {} }));
    assert.equal(uploads, 1, "a completed persona upload callback is retired");
    await act(async () => button("persona.modal.addEntry").click());
    await fill(dom.window.document.querySelector<HTMLInputElement>('input[placeholder="persona.modal.entryTitlePlaceholder"]')!, "Weapons");
    await act(async () => button("persona.modal.save").click());
    assert.equal(saves, 0, "an incomplete entry stays editable rather than being silently discarded");
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /entriesInvalid/);
    await fill(dom.window.document.querySelector<HTMLTextAreaElement>('textarea[placeholder="persona.modal.entryContentPlaceholder"]')!, "A steel sword.");
    await act(async () => button("persona.modal.save").click());
    assert.equal(saves, 1);
    assert.equal(saved.backstory, "Keep this story");
    assert.deepEqual(saved.entries, [{ title: "Weapons", content: "A steel sword." }]);
    assert.deepEqual((saved as typeof saved & { sprites?: Record<string, string> }).sprites, { normal: "https://cdn.example/normal.png" });
    await act(async () => render(false));
    await act(async () => render(true));
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[placeholder="persona.modal.entryTitlePlaceholder"]')!.value, "Weapons");
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="persona.modal.removeEntry"]')!.click());
    await act(async () => button("persona.modal.save").click());
    assert.deepEqual(saved.entries, []);
    deferUpload = true;
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Upload normal sprite"]')!.click());
    const oldImport = imageImport as PersonaImageImport;
    let pending!: Promise<void>;
    await act(async () => { pending = oldImport.onImport([new File(["image"], "late.png", { type: "image/png" })], { signal: new AbortController().signal, onProgress() {} }); });
    await act(async () => render(false));
    saved = { id: "other", name: "Morgan", backstory: "Other story", entries: [] };
    await act(async () => render(true));
    await act(async () => { finishUpload({ url: "/late-persona.png" }); await pending; });
    await act(async () => button("persona.modal.save").click());
    assert.deepEqual((saved as typeof saved & { sprites?: Record<string, string> }).sprites, {}, "a late upload cannot replace another persona's sprites");
    assert.equal(saved.backstory, "Other story");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
