import assert from "node:assert/strict";
import { act } from "react";
import type { JSDOM } from "jsdom";

/** JSDOM supplies DOM behavior; only layout observation needs a no-layout shim. */
export function controlGlobals(dom: JSDOM) {
  const win = dom.window;
  return {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
    Element: win.Element, Node: win.Node, NodeFilter: win.NodeFilter,
    DocumentFragment: win.DocumentFragment, ShadowRoot: win.ShadowRoot,
    Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
    CustomEvent: win.CustomEvent, MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
}

export async function openChoices(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new trigger.ownerDocument.defaultView!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const menu = trigger.ownerDocument.querySelector('[role="menu"]');
  assert.ok(menu, "The themed menu must open");
  return [...menu.querySelectorAll<HTMLDivElement>('[role="menuitemradio"]')];
}

export async function choose(trigger: HTMLButtonElement, label: string) {
  const choices = await openChoices(trigger);
  const choice = choices.find(option => option.textContent?.trim() === label);
  assert.ok(choice, `Expected available choice ${label}`);
  assert.notEqual(choice.getAttribute("aria-disabled"), "true");
  await act(async () => choice.click());
}

export async function choiceLabels(trigger: HTMLButtonElement) {
  const choices = await openChoices(trigger);
  const labels = choices.map(option => option.textContent?.trim());
  await act(async () => {
    choices[0]?.dispatchEvent(new trigger.ownerDocument.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return labels;
}
