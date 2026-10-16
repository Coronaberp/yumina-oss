import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement, type ContextType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div></div>");
const previous = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
const { MessageBubble } = await import("../../sandbox/chat/message-bubble");
const { YuminaContext } = await import("../../sandbox/sandbox-context");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("message display resolves the persona for stored, streamed, system and edited text", () => {
  const raw = "{{user}} waits for Cinder.";
  for (const name of ["Robin", "Alex"]) for (const role of ["user", "system", "assistant"] as const) {
    for (const isStreaming of [false, true]) {
      const message = { id: "persona-message", sessionId: "fixture", createdAt: "2026-10-13", role, content: raw, status: "complete" as const };
      const html = renderToStaticMarkup(createElement(YuminaContext.Provider, {
        value: { user: { name, avatar: null }, entries: [], language: "en" } as any,
      }, createElement(MessageBubble, { message, isStreaming, streamingContent: raw })));
      assert.ok(html.includes(`${name} waits for Cinder.`), html);
      assert.ok(!html.includes("{{user}}"), html);
      assert.equal(message.content, raw, "Display must not rewrite the stored message");
    }
  }
  const html = renderToStaticMarkup(createElement(YuminaContext.Provider, {
    value: { user: { name: "Robin", avatar: null }, entries: [], language: "en" } as any,
  }, createElement(MessageBubble, { message: { id: "editing", sessionId: "fixture", createdAt: "2026-10-13", role: "assistant", content: raw }, isEditing: true, editContent: raw })));
  assert.ok(html.includes("Robin waits for Cinder."));
  assert.ok(!html.includes("{{user}}"));
});

test("saved and streamed assistant bubbles hide declared angle commands while retaining raw output", () => {
  const raw = 'The lamps glow.\n<current-period: set "evening">';
  const variables = { "current-period": "day" };
  const message = { id: "angle-message", sessionId: "fixture", createdAt: "2026-10-13", role: "assistant" as const,
    content: raw, status: "complete" as const, swipes: [{ content: raw, rawContent: raw, createdAt: "2026-10-13" }] };
  for (const isStreaming of [false, true]) {
    const html = renderToStaticMarkup(createElement(YuminaContext.Provider, {
      value: { user: { name: "Robin", avatar: null }, entries: [], variables, language: "en" } as unknown as ContextType<typeof YuminaContext>,
    }, createElement(MessageBubble, { message, isStreaming, streamingContent: raw })));
    const root = dom.window.document.createElement("div"); root.innerHTML = html;
    assert.ok(root.textContent!.includes("The lamps glow."));
    assert.doesNotMatch(root.textContent!, /current-period/i);
    assert.equal(message.content, raw); assert.equal(message.swipes[0]!.rawContent, raw);
    assert.equal(variables["current-period"], "day", "Display cleanup must not reapply historical state commands");
  }
});
