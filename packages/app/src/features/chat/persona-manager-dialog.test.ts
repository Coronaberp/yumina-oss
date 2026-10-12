import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { SessionData } from "@/stores/chat";
import type { Persona } from "@/stores/personas";
import { createChatPersonaController, PersonaSaveUnconfirmedError } from "@/lib/refresh-chat-persona";

test("manager keeps one session persona, allows greeting changes, and disables changes after proceeding", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const a = { id: "A", name: "Session A", backstory: "Before", isActive: true } as Persona;
  const b = { id: "B", name: "Profile B", backstory: "B", isActive: false } as Persona;
  const session: SessionData = { id: "chat", worldId: "world", createdAt: "", updatedAt: "", personaLocked: true, personaSelectable: true,
    state: { variables: { hp: 9 }, metadata: { activeAudio: "song", personaName: a.name } },
    sessionPersona: { persona: { id: a.id, name: a.name } } };
  const chat = create(() => ({ session, isStreaming: false, messages: [] as { role: string }[], readOnly: false }));
  const personas = create(() => ({ personas: [a, b], fetchPersonas: async () => {} }));
  const calls: { url: string; init?: RequestInit }[] = [];
  let bound = a;
  let finishSave!: () => void;
  const receipt = () => ({ id: "chat", personaLocked: true, personaSelectable: true,
    sessionPersona: { persona: bound, selection: { kind: "player", id: bound.id } },
    state: { metadata: { personaActive: true, personaName: bound.name, personaImage: "", personaAppearance: "", personaPersonality: "", personaBackstory: bound.backstory, personaEntries: bound.entries ?? [] } } });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "PUT") {
      assert.equal(String(url), "/api/sessions/chat/persona-selection");
      assert.deepEqual(JSON.parse(String(init.body)), { selection: { kind: "player", id: "B" }, expectedVersion: "" });
      return new Promise<Response>(resolve => { finishSave = () => { bound = b; resolve(Response.json({ data: receipt() })); }; });
    }
    return Response.json({ data: receipt() });
  };
  const t = (key: string, values?: { name: string }) => values?.name ?? key;
  const shell = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t }) },
    "@/lib/asset-url": { resolveImageUrl: () => null },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", null, children) : null, DialogContent: shell, DialogTitle: shell },
    "@/features/personas/persona-carousel": { PersonaCarousel: ({ disabled, sessionSelection }: { disabled: boolean; sessionSelection: { personaId: string | null; onSelect: (id: string) => Promise<void> } }) => createElement("button", { disabled, "data-persona": sessionSelection.personaId, onClick: () => void sessionSelection.onSelect("B") }, "Select B") },
    "@/features/personas/persona-edit-modal": { PersonaEditModal: () => null },
    "@/components/ui/field-error": { FieldError: () => null },
    "@/stores/chat": { useChatStore: chat }, "@/stores/personas": { usePersonasStore: personas },
    "@/lib/refresh-chat-persona": { createChatPersonaController, PersonaSaveUnconfirmedError },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { PersonaManagerDialog: ComponentType<{ open: boolean; onClose: () => void; sessionId: string }> } };
  const source = readFileSync(new URL("./persona-manager-dialog.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => modules[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (open: boolean) => root.render(createElement(module.exports.PersonaManagerDialog, { open, onClose() {}, sessionId: "chat" }));
  const selectButton = () => dom.window.document.querySelector<HTMLButtonElement>("[data-persona]")!;
  try {
    await act(async () => render(true));
    assert.equal(selectButton().getAttribute("data-persona"), "A");
    assert.equal(dom.window.document.querySelector('[role="switch"]') === null, true);
    assert.equal(calls.length, 1);
    await act(async () => { personas.setState({ personas: [{ ...a, isActive: false }, { ...b, isActive: true }] }); });
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "A");
    assert.equal(calls.length, 1, "global default changes do not replace a session identity");
    await act(async () => { chat.setState({ isStreaming: true }); });
    await act(async () => {
      bound = { ...a, backstory: "Edited greeting profile" };
      personas.setState({ personas: [{ ...bound, isActive: false }, { ...b, isActive: true }] });
    });
    assert.equal(calls.length, 1);
    await act(async () => { chat.setState({ isStreaming: false }); });
    assert.equal(calls.length, 2);
    assert.equal((chat.getState().session.state.metadata as Record<string, unknown>).personaBackstory, "Edited greeting profile");
    await act(async () => selectButton().click());
    await act(async () => render(false));
    const beforeReceipt = calls.length;
    await act(async () => finishSave());
    assert.equal(calls.length, beforeReceipt, "closing the picker preserves a pending commit");
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "B");
    assert.deepEqual(chat.getState().session.state.variables, { hp: 9 });
    assert.equal((chat.getState().session.state.metadata as Record<string, unknown>).activeAudio, "song");
    await act(async () => render(true));
    assert.equal(selectButton().disabled, false, "selection remains available during the greeting");
    await act(async () => { chat.setState({ messages: [{ role: "user" }], session: { ...chat.getState().session, personaSelectable: false, sessionPersona: { ...chat.getState().session.sessionPersona!, started: true } } }); });
    assert.equal(selectButton().disabled, true);
    const beforeLockedClick = calls.length;
    await act(async () => selectButton().click());
    assert.equal(calls.length, beforeLockedClick, "the first player action closes persona selection");
    assert.match(dom.window.document.body.textContent ?? "", /greeting has ended/i);
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
