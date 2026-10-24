import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { ComponentProps } from "react";

test("narrow built-ins retain persona, entries, language, edits, failures and committed action guards", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "http://fixture.local" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Image: dom.window.Image, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client"); const container = dom.window.document.getElementById("root")!; const root = createRoot(container);
  try {
    const { BuiltinChatProvider, useBuiltinChat } = await import("../../../sandbox/chat/builtin-chat-context");
    const { YuminaContext, useYumina, buildAPI } = await import("../../../sandbox/sandbox-context");
    const { MessageBubble } = await import("../../../sandbox/chat/message-bubble");
    const { MessageActions } = await import("../../../sandbox/chat/message-actions");
    const { makeChatT } = await import("../../../sandbox/chat/i18n");
    const baseState = { variables: { energy: 95 }, globalVariables: { energy: 95 }, entries: [{ id: "guide", role: "character", name: "Guide", content: "A guide.", portrait: "/guide-before.png" }],
      user: { name: "Robin", avatar: null }, messages: [], worldName: "Fixture", worldId: "world", sessionId: "fixture", language: "en", isStreaming: false, streamingContent: "",
      capabilities: { canSendMessage: true, canPersistSession: true, canUseSessionApis: true, requiresAuth: false }, mode: "session", readOnly: false } as const;
    let phase = 1;
    const copied: string[] = [];
    let api = { ...buildAPI(baseState as any), copyToClipboard: (text: string) => { copied.push(`${phase}:${text}`); } };
    const text = 'Guide: "{{user}} is here."';
    let message: ComponentProps<typeof MessageBubble>["message"] = { id: "message", sessionId: "fixture", role: "assistant", content: text, status: "complete", createdAt: "2026-10-24T00:00:00Z",
      swipes: [{ content: text, rawContent: `[speaker:Guide]\n${text}` }], activeSwipeIndex: 0 };
    let props: Partial<ComponentProps<typeof MessageBubble>> = {};
    let probe: ReturnType<typeof useBuiltinChat> | undefined;
    let probeRenders = 0;
    function Probe() { probe = useBuiltinChat(); probeRenders++; return null; }
    const probeElement = createElement(Probe);
    function FullStateProbe() { const full = useYumina(); return createElement("output", { "data-full-state": true }, `${full.readOnly}:${full.capabilities.canUseSessionApis}`); }
    const fullStateElement = createElement(FullStateProbe);
    const render = () => act(async () => root.render(createElement(YuminaContext.Provider, { value: api }, createElement(BuiltinChatProvider, { api },
      probeElement, fullStateElement, createElement(MessageBubble, { message, ...props, children: createElement(MessageActions, { message, isLastAssistant: true, isLastMessage: true, onEditStart() {} }) })))));
    await render(); assert.match(container.textContent!, /Robin is here/); assert.equal(container.querySelector("img")?.getAttribute("src"), "/guide-before.png");
    const originalCopy = probe!.copyToClipboard;
    const beforeClone = probeRenders;
    phase = 2;
    api = { ...api, user: { ...api.user }, streamingContent: "Only public SDK data changed", copyToClipboard: text => { copied.push(`latest:${text}`); } };
    await render(); assert.equal(probeRenders, beforeClone, "same-value persona clones do not invalidate built-in reads");
    assert.equal(probe!.copyToClipboard, originalCopy, "delegates remain stable between SDK builds");
    probe!.copyToClipboard("proof"); assert.deepEqual(copied, ["latest:proof"], "actions call the latest committed API rather than a captured version");
    api = { ...api, language: "zh", user: { name: "Alex", avatar: null }, entries: [{ ...api.entries[0]!, portrait: "/guide-after.png" }], variables: { energy: 90 } };
    await render(); assert.match(container.textContent!, /Alex is here/); assert.equal(container.querySelector("img")?.getAttribute("src"), "/guide-after.png");
    assert.ok(container.querySelector(`button[title="${makeChatT("zh")("copy")}"]`), "language updates reach built-in actions");
    assert.equal(probe!.variables.energy, 90);

    function CustomRenderer({ content, variables }: any) { const full = useYumina(); return createElement("output", { "data-custom": true }, `${content}|${variables.energy}|${full.streamingContent}`); }
    const historicalVariables = { energy: 80 };
    props = { rendererComponent: CustomRenderer, variables: historicalVariables }; await render();
    assert.match(container.querySelector('[data-custom]')!.textContent!, /\|80\|/);
    api = { ...api, streamingContent: "Custom consumers remain live" }; await render();
    assert.match(container.querySelector('[data-custom]')!.textContent!, /Custom consumers remain live/);
    props = { ...props, variables: { energy: 70 } }; await render();
    assert.match(container.querySelector('[data-custom]')!.textContent!, /\|70\|/, "per-message variables update even when the public context did not change");
    props = { isEditing: true, editContent: "Unchanged edit", isSavingEdit: false }; await render();
    assert.equal(container.querySelector("textarea")!.disabled, false);
    props = { ...props, isSavingEdit: true }; await render();
    assert.equal(container.querySelector("textarea")!.disabled, true); assert.match(container.textContent!, /Saving/);
    api = { ...api, language: "en" }; props = { isLastMessage: false }; await render();
    message = { ...message, status: "failed", errorMessage: "[INTERRUPTED] stopped" }; await render();
    assert.ok(container.querySelector(".play-turn-error"), "changed message failure metadata is not swallowed by memo");
    assert.equal(container.querySelector(".play-turn-error__actions"), null);
    props = { isLastMessage: true }; await render();
    assert.ok(container.querySelector(".play-turn-error__actions"), "a trailing failed turn gains its retry controls");

    const sameDelegate = probe!.deleteMessage;
    api = buildAPI({ ...baseState, readOnly: true, capabilities: { ...baseState.capabilities, canUseSessionApis: false } } as any); await render();
    assert.equal(probe!.deleteMessage, sameDelegate);
    assert.equal(container.querySelector('[data-full-state]')!.textContent, "true:false", "read-only and capability changes remain reactive on the complete SDK");
    assert.equal(await probe!.deleteMessage("synthetic-unowned"), false, "the stable delegate observes the latest unavailable-session guard");
    api = buildAPI({ ...baseState, capabilities: { ...baseState.capabilities, canUseSessionApis: false } } as any); await render();
    assert.equal(container.querySelector('[data-full-state]')!.textContent, "false:false");
    assert.equal(await probe!.deleteMessage("synthetic-unowned"), false, "the latest capability guard remains active without a public-context row subscription");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
