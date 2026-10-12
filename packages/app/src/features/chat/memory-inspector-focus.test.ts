import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";

test("native memory inspector contains focus across its shadow portal", async () => {
  const dom = new JSDOM('<button id="outside">Outside</button><div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element,
    React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { SessionMemoryModal } = await import("../../../sandbox/extensions/session-memory/session-memory-modal");
  const { YuminaContext, useYumina } = await import("../../../sandbox/sandbox-context");
  const root = createRoot(document.getElementById("root")!);
  const outside = document.getElementById("outside")!;
  let closed = 0;
  function Inspector({ open }: { open: boolean }) {
    const api = useYumina();
    return createElement(YuminaContext.Provider, { value: { ...api, sessionId: "test", language: "en" } },
      createElement(SessionMemoryModal, { open, initialTab: "storyhaven", onClose: () => closed++ }));
  }
  const active = () => document.querySelector('[data-yumina-platform-overlay-host]')?.shadowRoot?.activeElement;
  const key = async (element: Element, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, composed: true, cancelable: true });
    await act(async () => element.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
  };
  try {
    outside.focus();
    await act(async () => root.render(createElement(Inspector, { open: true })));
    const dialog = document.querySelector('[data-yumina-platform-overlay-host]')!.shadowRoot!.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(![...dialog.querySelectorAll("button")].some(button => ["Summary", "Layers"].includes(button.textContent?.trim() ?? "")),
      "the built-in inspector does not expose controls for an uninstalled legacy extension");
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
    const first = controls[0], last = controls.at(-1)!;
    assert.ok(active() === first, "opening the actual inspector focuses its first control");
    await act(async () => last.focus());
    await key(last);
    assert.ok(active() === first, "Tab wraps inside the inspector instead of reaching VN controls");
    await key(first, true);
    assert.ok(active() === last, "Shift+Tab wraps within the shadow root");
    await act(async () => outside.focus());
    assert.ok(active() === first, "outside focus returns to the modal");
    const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    await act(async () => first.dispatchEvent(escape));
    assert.equal(closed, 1);
    await act(async () => root.render(createElement(Inspector, { open: false })));
    assert.ok(document.activeElement === outside, "closing the modal restores its connected opener");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
