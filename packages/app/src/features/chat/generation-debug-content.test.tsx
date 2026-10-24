import test from "node:test";
import assert from "node:assert/strict";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";

test("debug requests are gated, lazy, per-message/swipe, and cleared across switches, close, errors and repeat opens", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://fixture.local", pretendToBeVisual: true });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
  let allowed = true, fail = false, deferred: ((value: Response) => void) | undefined;
  let defer = false;
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal });
      if (url.includes("-access")) return Response.json({ data: { allowed } });
      if (defer) return new Promise<Response>(resolve => { deferred = resolve; });
      if (fail) return new Response("PRIVATE_ERROR_BODY", { status: 500 });
      return Response.json({ data: { available: false, reason: "not-retained" } });
    },
  };
  for (const [key, value] of Object.entries(globals)) { prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const { createRoot } = await import("react-dom/client");
  const { GenerationDebugContent } = await import("./generation-debug-content");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const messages = [
    { id: "m1", role: "assistant", content: "first reply", activeSwipeIndex: 0, swipes: [{ content: "first reply", rawContent: "RAW_ONE" }, { content: "alternative", rawContent: "RAW_ALTERNATIVE" }] },
    { id: "m2", role: "assistant", content: "second reply", activeSwipeIndex: 0, swipes: [{ content: "second reply", rawContent: "RAW_TWO" }] },
  ];
  const render = async (eligible = true) => { await act(async () => { root.render(createElement(GenerationDebugContent, { key: String(eligible), sessionId: "s", messages, eligible, apiBase: "" })); }); };
  const button = (label: string) => Array.from(dom.window.document.querySelectorAll("button")).find(node => node.textContent === label)!;
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  try {
    await render(false);
    assert.equal(calls.length, 0, "ordinary players never probe inspection");
    assert.equal(button("Actual request"), undefined);
    await render(true);
    assert.equal(calls.length, 1, "opening checks only permission, never loads request bodies");
    assert.match(dom.window.document.body.textContent!, /RAW_TWO/);
    await click("Actual request");
    assert.match(calls.at(-1)!.url, /m2\/request-inspection\?swipe=0/);
    assert.match(dom.window.document.body.textContent!, /No retained request/);
    const select = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Reply"]')!;
    defer = true;
    await act(async () => { select.value = "m1"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    const pending = calls.at(-1)!;
    const stale = deferred!;
    assert.match(dom.window.document.body.textContent!, /Loading request/);
    await act(async () => { const swipe = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Swipe"]')!; swipe.value = "1"; swipe.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(pending.signal?.aborted, true);
    const latest = deferred!;
    await act(async () => { latest(Response.json({ data: { available: true, receipts: [{ id: "r", kind: "regenerate", capturedAt: "2026-10-25T00:00:00Z", omittedAttempts: 0, attempts: [{ provider: "custom", model: "wire-model", parameters: { temperature: .4 }, estimatedTextTokens: 20, truncated: true, sections: [{ name: "messages[0]", text: "ACTUAL_REQUEST" }] }] }] } })); });
    assert.match(dom.window.document.body.textContent!, /ACTUAL_REQUEST/);
    await act(async () => { stale(Response.json({ data: { available: true, receipts: [{ id: "stale", attempts: [], kind: "send", capturedAt: "2026-10-25T00:00:00Z", omittedAttempts: 0 }] } })); });
    assert.match(dom.window.document.body.textContent!, /ACTUAL_REQUEST/, "an older reply's response cannot replace the selected swipe");
    assert.match(dom.window.document.body.textContent!, /Unknown/);
    assert.match(dom.window.document.body.textContent!, /Truncated/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /RAW_ONE/);
    await click("Raw reply");
    assert.match(dom.window.document.body.textContent!, /RAW_ALTERNATIVE/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /ACTUAL_REQUEST/);
    defer = false; fail = true;
    await click("Actual request");
    assert.match(dom.window.document.body.textContent!, /Could not load/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /PRIVATE_ERROR_BODY/);
    fail = false; await click("Retry");
    assert.match(dom.window.document.body.textContent!, /No retained request/);
    defer = true; await click("Raw reply"); await click("Actual request");
    const closing = calls.at(-1)!;
    await act(async () => { root.render(null); });
    assert.equal(closing.signal?.aborted, true);
    await act(async () => { deferred!(Response.json({ data: { available: false } })); });
    defer = false; allowed = false;
    await render();
    assert.equal(button("Actual request"), undefined, "repeat open rechecks revoked permission");
    assert.doesNotMatch(dom.window.document.body.textContent!, /ACTUAL_REQUEST/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
