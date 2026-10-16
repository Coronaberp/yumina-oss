import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import { canSelectStoryOpening } from "@/lib/can-select-story-opening";

test("Routes and Chapters share greeting selection and disappear after departure", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const switched: number[] = [], refreshed: unknown[] = [];
  const opening = { id: "opening", role: "assistant", activeSwipeIndex: 0, swipes: [
    { stateSnapshot: { activeGreetingId: "origin" } }, { stateSnapshot: { activeGreetingId: "holder" } },
  ] };
  const chat = create(() => ({
    session: { id: "play", state: { variables: { hp: 9 }, activeGreetingId: "origin" } },
    messages: [opening], isStreaming: false, hasEarlierMessages: false, readOnly: false,
    switchGreeting: (index: number) => switched.push(index),
    refreshMessages: async (options: unknown) => { refreshed.push(options); },
  }));
  const ui = create<{ storyRoutesOpen: boolean; openStoryRoutes: () => void; closeStoryRoutes: () => void }>((set) => ({
    storyRoutesOpen: false,
    openStoryRoutes: () => set({ storyRoutesOpen: true }), closeStoryRoutes: () => set({ storyRoutesOpen: false }),
  }));
  globalThis.fetch = async () => { throw new Error("The starting picker must not fetch or transition chapters"); };
  const shell = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const modules: Record<string, unknown> = {
    "@/lib/can-select-story-opening": { canSelectStoryOpening },
    "@/stores/chat": { useChatStore: chat }, "@/stores/ui": { useUiStore: ui },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? shell({ children }) : null,
      DialogContent: shell, DialogHeader: shell, DialogTitle: shell, DialogDescription: shell },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { StoryNavigation?: ComponentType<any>; ChapterNavigation: ComponentType<any> } };
  const source = readFileSync(new URL("./chapter-navigation.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => modules[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (showTrigger = true) => root.render(createElement(module.exports.StoryNavigation ?? module.exports.ChapterNavigation, {
    showTrigger, chapters: [{ id: "past", name: "Past chapter", timeline: "Main", date: "2250", greetingIds: ["origin"] }, { id: "future", name: "Future chapter", timeline: "Main", date: "2280", greetingIds: ["holder"] }],
    greetings: [{ id: "holder", name: "Holder" }, { id: "origin", name: "Origin" }],
  }));
  const button = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
  try {
    await act(async () => render());
    assert.ok(dom.window.document.querySelector('[aria-label="Open routes"]'), "Routes replaces the separate Chapters trigger");
    assert.equal(dom.window.document.querySelector('[aria-label="Open chapters"]'), null);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Open routes"]')!.click());
    await act(async () => button("Holder").click());
    assert.deepEqual(switched, [1], "greeting identity comes from its saved swipe, not reordered lore entries");
    assert.equal(ui.getState().storyRoutesOpen, false);
    await act(async () => ui.getState().openStoryRoutes());
    await act(async () => button("Chapters").click());
    assert.ok(dom.window.document.body.textContent?.includes("Future chapter"));
    await act(async () => button("Holder").click());
    assert.deepEqual(switched, [1, 1], "chapters pick an opening without appending a story turn");
    await act(async () => render(false));
    assert.equal(dom.window.document.querySelector('[aria-label="Open routes"]'), null, "VN supplies its own entry button");
    await act(async () => ui.getState().openStoryRoutes());
    assert.ok(button("Chapters"), "the VN bridge opens the same starting window");
    await act(async () => chat.setState({ messages: [opening, { id: "reply", role: "assistant", activeSwipeIndex: 0, swipes: [] }] }));
    assert.equal(dom.window.document.body.textContent, "", "leaving the greeting removes the entire picker");
    await act(async () => ui.getState().openStoryRoutes());
    assert.equal(dom.window.document.body.textContent, "", "a stale bridge cannot reopen it after departure");
    await act(async () => { chat.setState({ messages: [opening], hasEarlierMessages: true }); render(); });
    assert.equal(dom.window.document.body.textContent, "", "a windowed history is not mistaken for a new greeting");
    await act(async () => chat.setState({ hasEarlierMessages: false, isStreaming: true }));
    assert.equal(dom.window.document.body.textContent, "");
    await act(async () => chat.setState({ isStreaming: false, readOnly: true }));
    assert.equal(dom.window.document.body.textContent, "");
    assert.deepEqual(refreshed, [], "starting selection never fetches or appends chapter transition messages");
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
