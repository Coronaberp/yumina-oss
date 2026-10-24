import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import type { SandboxedYuminaAPI } from "../../../sandbox/sandbox-context";

test("built-in completed rows avoid token-only commits while streaming and custom SDK consumers stay live", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "http://fixture.local" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const appRoot = fileURLToPath(new URL("../../../", import.meta.url));
  let instrumented = 0;
  const opening = '  return (\n    <div\n      className={cn(\n        "play-message-block group relative",';
  const closing = '    </div>\n  );\n};\n\n/**\n * Memoized message bubble';
  // Test-only instrumentation puts a real React Profiler inside the actual
  // render function. An outer Profiler can bail out while context work below
  // it renders, and therefore undercount the work this regression targets.
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, watch: null }, resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
    plugins: [{ name: "measure-real-bubble", enforce: "pre", transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/sandbox/chat/message-bubble.tsx")) return;
      assert.ok(code.includes(opening) && code.includes(closing), "real bubble measurement anchors remain valid"); instrumented++;
      return code.replace(opening, opening.replace('  return (\n', '  return (\n    <React.Profiler id={message.id} onRender={(...args) => (globalThis as any).__yuminaMeasureBubble(...args)}>\n'))
        .replace(closing, closing.replace('    </div>\n  );', '    </div>\n    </React.Profiler>\n  );'));
    } }],
  });
  const { MessageBubble } = await vite.ssrLoadModule("/sandbox/chat/message-bubble.tsx") as typeof import("../../../sandbox/chat/message-bubble");
  const { MessageActions } = await vite.ssrLoadModule("/sandbox/chat/message-actions.tsx") as typeof import("../../../sandbox/chat/message-actions");
  const { SwipeControls } = await vite.ssrLoadModule("/sandbox/chat/swipe-controls.tsx") as typeof import("../../../sandbox/chat/swipe-controls");
  const { YuminaContext, useYumina, buildAPI } = await vite.ssrLoadModule("/sandbox/sandbox-context.tsx") as typeof import("../../../sandbox/sandbox-context");
  const { withVariableNameAliases } = await vite.ssrLoadModule("/sandbox/variable-alias.ts") as typeof import("../../../sandbox/variable-alias");
  const privateModule = await vite.ssrLoadModule("/sandbox/chat/builtin-chat-context.tsx").catch(() => null);
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const variables = { energy: 95 };
  const entries = [{ id: "guide", name: "Guide", content: "A guide.", role: "character", portrait: null }];
  const messages = Array.from({ length: 25 }, (_, index) => ({ id: `reply-${index}`, sessionId: "fixture", role: "assistant" as const,
    content: `A quiet completed reply ${index} for {{user}}.`, createdAt: "2026-10-24T00:00:00Z", status: "complete" as const,
    model: "fixture-model", swipes: [{ content: `A quiet completed reply ${index} for {{user}}.`, model: "fixture-model", createdAt: "2026-10-24T00:00:00Z" }] }));
  // Match the real channel reducer: postMessage clones the incoming channel,
  // not every previously retained channel. assembleState then reuses session
  // entry/user references and the WeakMap-cached variable-name alias proxy.
  let channels = { variables: structuredClone({ variables, variableIdsByName: { Energy: "energy" } }),
    session: structuredClone({ entries, user: { name: "Robin", avatar: null } }), streaming: { isStreaming: false, content: "", tokenCount: 0 } };
  const makeAPI = (isStreaming: boolean, token: number) => {
    channels = { ...channels, streaming: structuredClone({ isStreaming, content: `The stream continues ${token}.`, tokenCount: token }) };
    return buildAPI({ variables: withVariableNameAliases(channels.variables.variables, channels.variables.variableIdsByName),
      globalVariables: channels.variables.variables, entries: channels.session.entries, user: channels.session.user,
      messages, worldName: "Fixture", worldId: "world", sessionId: "fixture", isStreaming: channels.streaming.isStreaming,
      streamingContent: channels.streaming.content, streamingTokenCount: channels.streaming.tokenCount, language: "en", readOnly: false,
      capabilities: { canSendMessage: true, canPersistSession: true, canUseSessionApis: true, requiresAuth: false }, mode: "session" } as any);
  };
  let completedCommits = 0, streamingCommits = 0, customRenders = 0;
  const measureKey = "__yuminaMeasureBubble";
  const oldMeasure = Object.getOwnPropertyDescriptor(globalThis, measureKey);
  Object.defineProperty(globalThis, measureKey, { configurable: true, value: (id: string) => {
    if (id.startsWith("reply-")) completedCommits++;
    else if (id === "stream") streamingCommits++;
  } });
  const completedRows = messages.map((message, index) => createElement(MessageBubble, { key: message.id, message, variables, isLastMessage: index === 24, actionsKey: `${index === 24}`,
    swipeControls: createElement(SwipeControls, { message }),
    children: createElement(MessageActions, { message, isLastMessage: index === 24, isLastAssistant: index === 24, onEditStart() {} }) }));
  const streamMessage = { id: "stream", sessionId: "fixture", role: "assistant" as const, content: "", createdAt: "2026-10-24T00:00:00Z" };
  function LiveConsumers() {
    const api = useYumina();
    customRenders++;
    return createElement(React.Fragment, null,
      createElement("output", { "data-full-sdk": true }, `${api.streamingTokenCount}:${api.streamingContent}`),
      api.isStreaming && createElement(MessageBubble, { message: streamMessage, isStreaming: true, streamingContent: api.streamingContent, variables }));
  }
  const children = createElement(React.Fragment, null, ...completedRows, createElement(LiveConsumers));
  const run = async (narrow: boolean) => {
    const render = async (api: SandboxedYuminaAPI) => act(async () => root.render(createElement(YuminaContext.Provider, { value: api },
      narrow ? createElement(privateModule!.BuiltinChatProvider, { api }, children) : children)));
    await render(makeAPI(false, 0));
    completedCommits = 0; await render(makeAPI(true, 0));
    const startCommits = completedCommits;
    const generateButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".play-message-block .rounded-full button:last-child")];
    assert.equal(generateButtons().length, 25);
    assert.ok(generateButtons().every(button => button.disabled), "isStreaming start disables completed-row variant generation");
    completedCommits = 0; streamingCommits = 0; customRenders = 0;
    const identity = makeAPI(true, 0);
    for (let token = 1; token <= 20; token++) {
      const next = makeAPI(true, token);
      assert.equal(next.entries, identity.entries); assert.equal(next.user, identity.user); assert.equal(next.variables, identity.variables);
      await render(next);
    }
    const result = { completedRows: 25, tokenUpdates: 20, completedCommits, streamingCommits, customRenders, startCommits, endCommits: 0 };
    assert.equal(streamingCommits, 20, "the active streaming bubble still commits each supplied update");
    assert.equal(customRenders, 20, "custom useYumina consumers still receive the full streaming SDK");
    assert.match(container.querySelector('[data-full-sdk]')!.textContent!, /20:The stream continues 20/);
    completedCommits = 0; await render(makeAPI(false, 20));
    result.endCommits = completedCommits;
    assert.ok(generateButtons().every(button => !button.disabled), "isStreaming end restores completed-row variant generation");
    return result;
  };
  try {
    assert.equal(instrumented, 1, "measure the real imported bubble, not a lookalike renderer");
    const baseline = await run(false);
    console.log("CHAT_CONTEXT_BASELINE", JSON.stringify(baseline));
    assert.equal(baseline.completedCommits, 500, "legacy public-context embedding reproduces token fan-out");
    assert.ok(privateModule?.BuiltinChatProvider, "a built-in-only narrow provider is available");
    // A separate mount gives comparable initial state and avoids switching
    // hook fallback modes inside an already mounted synthetic tree.
    await act(async () => root.render(null));
    const narrowed = await run(true);
    console.log("CHAT_CONTEXT_NARROWED", JSON.stringify(narrowed));
    assert.equal(narrowed.completedCommits, 0, "completed built-in rows must not commit for unrelated token updates");
  } finally {
    await act(async () => root.unmount()); await vite.close();
    if (oldMeasure) Object.defineProperty(globalThis, measureKey, oldMeasure); else Reflect.deleteProperty(globalThis, measureKey);
    dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
