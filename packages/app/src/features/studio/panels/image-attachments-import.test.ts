import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { JSDOM } from "jsdom";
import * as React from "react";

test("Studio image paste waits for shared confirmation, keeps documents separate and rejects stale confirmations", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  const require = createRequire(import.meta.url), { create } = require("zustand");
  const noop = () => {};
  const editor = create(() => ({ serverWorldId: "world-a", worldDraft: { id: "draft-a" } }));
  let sends = 0;
  const studio = create((set: (value: unknown) => void) => ({
    chatWorldId: "world-a", chatConversationId: null, chatMessages: [], chatAttachments: [] as File[],
    chatStreamContent: "", reasoningContent: "", reasoningChars: 0, appliedCount: 0,
    activeTask: null, taskStepLimit: null, agentHistoryTokens: null, agentCompaction: null,
    addChatAttachment: (file: File) => set((s: { chatAttachments: File[] }) => ({ chatAttachments: [...s.chatAttachments, file] })),
    removeChatAttachment: noop, clearChat: () => set({ chatAttachments: [], chatMessages: [] }),
    refreshCreditPause: noop, sendChatMessage: () => { sends++; }, steerChatMessage: () => { sends++; },
    isAgentWorking: false,
  }));
  const profile = create(() => ({ profile: { preferences: {} }, fetchProfile: noop }));
  let importer: { initialFiles?: File[]; maxFiles?: number; crop?: string; preserveOriginal?: boolean; onImport: (files: File[], ctx: object) => void; onClose: () => void } | null = null;
  const child = () => null;
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) },
    "@/stores/editor": { useEditorStore: editor },
    "@/stores/studio": { useStudioStore: studio, watchStudioImageNotifications: () => noop },
    "@/stores/user-profile": { useUserProfileStore: profile },
    "@/edition/slots.state": { useCreditStore: (selector: (s: object) => unknown) => selector({ fetchCredits: noop, balance: 0 }) },
    "@/edition/edition": { useFeature: () => false },
    "@/edition/routes": { getPlansHref: () => "/" },
    "@/lib/utils": { cn: (...args: unknown[]) => args.filter(Boolean).join(" ") },
    "@/lib/feedback": { feedback: { error: noop } },
    "@/lib/clipboard-image": { getImageFilesFromTransfer: (data: { files?: File[] }) => data?.files ?? [] },
    "@/components/image-import-dialog": { ImageImportDialog: (props: typeof importer) => { importer = props; return React.createElement("div", { "data-image-import": true }); } },
    "@/components/ui/select": { Select: child },
    "@/components/image-lightbox": { ImageLightbox: child },
    "@/lib/composer-submit": { useComposerSubmit: () => ({}) },
    "@/lib/studio-markdown": { renderStudioMarkdown: () => "" },
    "../lib/context-tokens": { classifyUsage: () => ({}), estimateHistoryTokens: () => 0, getContextBudget: () => 1000 },
    "../lib/types": { getStudioQuestionReplies: () => [], isReadTool: () => false, serializeStudioChatMessages: () => [] },
  };
  const fallback = new Proxy({}, { get: () => child });
  const module = { exports: {} as { AiChatPanel: React.ComponentType } };
  const source = readFileSync(new URL("./ai-chat-panel.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? (id.startsWith("../components/") ? fallback : require(id)), module, module.exports);
  const root = require("react-dom/client").createRoot(document.getElementById("root"));
  const image = new File(["image"], "clipboard.png", { type: "image/png" });
  const context = () => ({ signal: new AbortController().signal, onProgress: noop });
  const paste = async (files: File[]) => {
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files } });
    await React.act(async () => document.querySelector("textarea")!.dispatchEvent(event));
    return event;
  };
  try {
    await React.act(async () => root.render(React.createElement(module.exports.AiChatPanel)));
    assert.equal((await paste([])).defaultPrevented, false);
    await paste([image]);
    assert.ok(document.querySelector("[data-image-import]"), "Studio image paste must use shared import confirmation");
    assert.equal(studio.getState().chatAttachments.length, 0);
    assert.equal(importer!.preserveOriginal, true); assert.equal(importer!.crop, "none"); assert.equal(importer!.maxFiles, 5);
    const oldConfirm = importer!.onImport;
    await React.act(async () => importer!.onImport([image], context()));
    assert.equal(studio.getState().chatAttachments.length, 1);
    await React.act(async () => oldConfirm([image], context()));
    assert.equal(studio.getState().chatAttachments.length, 1, "duplicate confirmation cannot duplicate attachments");
    await React.act(async () => importer!.onClose());
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(input.accept.includes(".tsx"), "code chooser remains available");
    const code = new File(["export {}"], "component.tsx", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [code] });
    await React.act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.ok(studio.getState().chatAttachments.includes(code));
    await paste([image]); const stale = importer!.onImport;
    await React.act(async () => editor.setState({ serverWorldId: "world-b", worldDraft: { id: "draft-b" } }));
    const count = studio.getState().chatAttachments.length;
    await React.act(async () => stale([image], context()));
    assert.equal(studio.getState().chatAttachments.length, count);
    assert.equal(sends, 0);
  } finally {
    await React.act(async () => root.unmount()); globalThis.fetch = fetchBefore; dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
