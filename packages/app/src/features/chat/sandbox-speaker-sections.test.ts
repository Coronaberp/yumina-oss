import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement, type ComponentProps } from "react";
import { JSDOM } from "jsdom";

test("one reply renders multiple portraits while keeping thinking and actions reply-wide", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { MessageBubble } = await import("../../../sandbox/chat/message-bubble");
  const { YuminaContext } = await import("../../../sandbox/sandbox-context");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  type Api = NonNullable<React.ContextType<typeof YuminaContext>>;
  const api = { language: "en", entries: [
    { name: "Evelia", role: "character", portrait: "/cdn/evelia" },
    { name: "Miveth", role: "character", portrait: "/cdn/miveth" },
    { name: "Diane (Bluerose)", role: "character", portrait: "/cdn/diane" },
  ] } as unknown as Api;
  const text = '*The room is warm.*\n\n*Evelia smiles.* "Wine? \\*Please\\*."\n\n*Miveth watches.* "No."';
  const message = { id: "reply", role: "assistant", content: text, activeSwipeIndex: 0, swipes: [
    { content: text, rawContent: `[speaker: narrator]\n${text}`, reasoningContent: "Saved thinking." },
    { content: "Miveth: Another version.", rawContent: "[speaker: Miveth]\nMiveth: Another version." },
  ] } as ComponentProps<typeof MessageBubble>["message"];
  const render = async (props: Partial<ComponentProps<typeof MessageBubble>> = {}) => {
    await act(async () => root.render(createElement(YuminaContext.Provider, { value: api }, createElement(MessageBubble, {
      message, children: createElement("button", { "data-test": "actions" }, "Actions"),
      swipeControls: createElement("div", { "data-test": "swipes" }, "1/2"), ...props,
    }))));
  };
  try {
    await render();
    assert.equal(container.querySelectorAll(".play-message-block").length, 1);
    assert.equal(container.querySelectorAll(".play-message-speaker img").length, 2);
    assert.deepEqual(Array.from(container.querySelectorAll(".play-message-section")).map(e => e.getAttribute("data-speaker")), ["narrator", "Evelia", "narrator", "Miveth"]);
    for (const section of container.querySelectorAll(".play-message-section")) {
      assert.ok(!/^\s*<br\b/i.test(section.lastElementChild?.innerHTML ?? ""), "paragraph separators must not add blank lines below the portrait");
    }
    assert.equal(container.querySelectorAll('[data-test="actions"]').length, 1);
    assert.equal(container.querySelectorAll('[data-test="swipes"]').length, 1);
    const thinking = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    assert.equal(thinking.getAttribute("aria-expanded"), "false");
    await act(async () => thinking.click());
    assert.ok(container.textContent!.includes("Saved thinking."));
    assert.equal(container.querySelectorAll("em").length, 3);
    assert.equal(container.querySelectorAll('.play-message-section[data-speaker="Evelia"] em, .play-message-section[data-speaker="Miveth"] em').length, 0);
    assert.equal(container.querySelector('.play-message-section[data-speaker="Evelia"]')!.lastElementChild!.textContent!.trim(), '"Wine? Please."');
    await render({ message: { ...message, content: message.swipes![1]!.content, activeSwipeIndex: 1 } });
    assert.equal(container.querySelectorAll(".play-message-speaker img").length, 1);
    assert.match(container.textContent!, /Another version/);
    assert.ok(!container.textContent!.includes("Wine?"));
    await render({ isStreaming: true, streamingContent: "[spea", streamingReasoning: "Streaming thinking." });
    assert.equal(container.querySelectorAll(".play-message-section").length, 0);
    assert.ok(!container.textContent!.includes("[spea"));
    await render({ isStreaming: true, streamingContent: '[speaker: narrator]\nNarrator: A room.\n\nEvelia: Hello.\n\nMiveth: Hi.' });
    assert.equal(container.querySelectorAll(".play-message-speaker img").length, 2);
    assert.ok(!container.textContent!.includes("[speaker:"));
    const incident = '"Next. Name. Now."\n\n*Diane says* "Hmph, stupid peasants blocking my path."';
    await render({ message: { ...message, content: incident, swipes: [{ content: incident, rawContent: incident }] } });
    assert.deepEqual(Array.from(container.querySelectorAll(".play-message-section")).map(section => section.getAttribute("data-speaker")), ["NPC", "narrator", "Diane (Bluerose)"]);
    assert.equal(container.querySelector('.play-message-section[data-speaker="NPC"] .play-message-role')?.textContent, "NPC");
    assert.equal(container.querySelectorAll('.play-message-section[data-speaker="NPC"] img').length, 0);
    assert.equal(container.querySelector('.play-message-section[data-speaker="Diane (Bluerose)"] img')?.getAttribute("src"), "/cdn/diane");
    assert.equal(container.querySelectorAll("em").length, 1, "the named attribution remains an italic action");
    await render({ message: { ...message, role: "user", content: text } });
    assert.equal(container.querySelectorAll(".play-message-speaker img").length, 0);
    assert.equal(container.querySelectorAll(".play-message-section").length, 0);
    const Custom = () => createElement("div", { "data-test": "custom" }, "Custom renderer");
    await render({ rendererComponent: Custom });
    assert.equal(container.querySelectorAll('[data-test="custom"]').length, 1);
    assert.equal(container.querySelectorAll(".play-message-section").length, 0);
    await render({ isEditing: true, editContent: text });
    assert.equal(container.querySelectorAll("textarea").length, 1);
    assert.equal(container.querySelectorAll(".play-message-section").length, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
