import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = existsSync(source) ? Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")])) : {};
type Passage = { name: string; kind: "dialogue" | "narration"; text: string; emotion: string };

test("Route switches opening greetings and backgrounds, then disappears when the first reply is sent", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const openings = ['*You arrive.*\n\nClerk: "Welcome."', '*You awaken as a slime.*'];
  const greeting = { id: "opening", role: "assistant", content: openings[0], activeSwipeIndex: 0, swipes: openings.map(content => ({ content })), stateSnapshot: { activeGreetingId: "enrollment" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Simulate live SDK updates, including the optimistic user message.
  const api: any = {
    sessionId: "route-test", worldId: "world", worldName: "Academy", variables: {},
    entries: [{ id: "summoning", name: "Summoning", role: "greeting", enabled: true, position: 2 }, { id: "disabled", name: "Disabled", role: "greeting", enabled: false, position: 0 }, { id: "enrollment", name: "Enrollment", role: "greeting", enabled: true, position: 1 }],
    messages: [greeting], pendingChoices: [], isStreaming: false, hasEarlierMessages: false, readOnly: false,
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (s: string) => s, resolveAssetUrl: (s: string) => s,
    switchGreeting: (index: number) => { greeting.activeSwipeIndex = index; greeting.content = openings[index]; greeting.stateSnapshot = { activeGreetingId: index ? "summoning" : "enrollment" }; },
    sendMessage: (content: string) => { api.messages = [greeting, { id: "reply", role: "user", content }]; api.isStreaming = true; },
  };
  const routeFiles = { ...files, "scenes.ts": files["scenes.ts"].replace('export const scenes = {};', 'export const scenes = { default: "global.png" };').replace('export const openingScenes = {};', 'export const openingScenes = { enrollment: { opening: { day: "enrollment.png" } }, summoning: { opening: { day: "summoning.png" } } };') };
  const result = bundleAndCompile({ files: routeFiles, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
    assert.ok(button, "Missing button " + label);
    await act(async () => button.click());
  };
  try {
    await render();
    assert.equal(container.querySelector('.vn-bg')?.getAttribute("src"), "enrollment.png");
    assert.deepEqual(Array.from(container.querySelectorAll(".vn-controls button")).map(b => b.getAttribute("aria-label")), ["Log", "Route", "Hide", "Skip", "Auto", "Menu"]);
    assert.ok(container.querySelector('.vn-control.route svg'), "Route has a map icon");
    await click("Advance story");
    assert.ok(container.querySelector('.vn-control.route'), "Route remains across pages of the opening message");
    await click("Route");
    const routes = Array.from(container.querySelectorAll<HTMLButtonElement>(".vn-route-option"));
    assert.deepEqual(routes.map(b => b.textContent?.trim()), ["Enrollment", "Summoning"]);
    assert.equal(routes[0].getAttribute("aria-pressed"), "true");
    await act(async () => routes[1].click());
    await render();
    assert.equal(greeting.activeSwipeIndex, 1);
    assert.equal(container.querySelector('.vn-bg')?.getAttribute("src"), "summoning.png");
    assert.equal(container.querySelector('.vn-routes'), null);
    assert.match(container.querySelector('.vn-dialogue')!.textContent!, /You awaken as a slime/);
    assert.match(container.querySelector('.vn-progress')!.textContent!, /Page 1 of 1/);
    await click("Route");
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.activeElement, container.querySelector('.vn-control.route'), "Escape returns focus to Route");
    await click("Write your own choice");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(textarea, "Hello"); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await click("Send choice");
    await render();
    assert.equal(api.messages[1].role, "user");
    assert.equal(container.querySelector('.vn-control.route'), null, "hidden immediately during first reply streaming");
    api.isStreaming = false;
    api.messages.push({ id: "response", role: "assistant", content: '*The story continues.*', stateSnapshot: { activeGreetingId: "summoning" } });
    api.messages[0] = { ...greeting, stateSnapshot: null };
    await render();
    assert.equal(container.querySelector('.vn-bg')?.getAttribute("src"), "summoning.png", "recent snapshots retain the background after the opening snapshot is pruned");
    await click("Advance story");
    assert.equal(container.querySelector('.vn-control.route'), null, "stays hidden after the first reply");
    api.messages = [greeting]; api.hasEarlierMessages = true;
    await render();
    assert.equal(container.querySelector('.vn-control.route'), null, "a paginated history cannot appear to be a fresh opening");
    api.hasEarlierMessages = false; api.readOnly = true;
    await render();
    assert.equal(container.querySelector('.vn-control.route'), null, "read-only previews cannot switch a session greeting");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("VN card compiles through the real sandbox bundler", () => {
  const result = bundleAndCompile({ files, entryFile: "index.tsx" });
  assert.equal(result.error, null, result.error ?? undefined);
  assert.ok(result.Component);
});

test("the official VN scene template labels undefined speakers NPC and resolves defined short names", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  const entries = [{ name: "Diane (Bluerose)", role: "character" }];
  const template = readFileSync(new URL("../../../../server/skills/tsx/templates/vn-scene-engine/component.tsx", import.meta.url), "utf8");
  const result = bundleAndCompile({ files: { "index.tsx": template }, entryFile: "index.tsx" }, () => ({ entries, sessionId: "template-npc", resolveAssetUrl: (ref: string) => ref }));
  assert.equal(result.error, null, result.error ?? undefined);
  try {
    for (const [speaker, name] of [["Clerk", "NPC"], ["NPC", "NPC"], ["__proto__", "NPC"], ["Diane", "Diane (Bluerose)"], ["Sakura", "Sakura"], ["Narrator", null]]) {
      const html = renderToStaticMarkup(createElement(result.Component!, { variables: { segments: [{ speaker, emotion: "normal", text: "Welcome." }] }, worldName: "Academy" }));
      const dom = new JSDOM(html);
      assert.equal(dom.window.document.querySelector('[aria-label="Speaker"]')?.textContent ?? null, name);
      dom.window.close();
    }
    entries.push({ name: "Diane (Redrose)", role: "character" });
    const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!, { variables: { segments: [{ speaker: "Diane", text: "Welcome." }] } })));
    assert.equal(dom.window.document.querySelector('[aria-label="Speaker"]')?.textContent, "NPC");
    dom.window.close();
    for (const [name, alias] of [["Lilith Vexthorne", "Lilith"], ["Diane Bluerose", "Bluerose"], ["Ryu (Ryutharax)", "Ryutharax"], ["阿璃 (Ari)", "阿璃"]]) {
      entries.splice(0, entries.length, { name, role: "character" });
      const markup = renderToStaticMarkup(createElement(result.Component!, { variables: { segments: [{ speaker: alias, text: "Welcome." }] } }));
      const sample = new JSDOM(markup);
      assert.equal(sample.window.document.querySelector('[aria-label="Speaker"]')?.textContent, name);
      sample.window.close();
    }
    const pools = { male: { a: "@asset:male-a", b: "@asset:male-b" }, female: { a: "@asset:female-a" } };
    const inspectNpc = (speaker: string, gender: string) => {
      const html = renderToStaticMarkup(createElement(result.Component!, { variables: { "vn-npc-sprites": pools, segments: [{ speaker, gender, npcId: "clerk", emotion: "normal", text: "Welcome." }] } }));
      const document = new JSDOM(html);
      const value = { label: document.window.document.querySelector('[aria-label="Speaker"]')?.textContent ?? null, sprite: document.window.document.querySelector('img')?.getAttribute('src') ?? null };
      document.window.close();
      return value;
    };
    const male = inspectNpc("NPC", "male");
    assert.equal(male.label, "NPC");
    assert.ok(Object.values(pools.male).includes(male.sprite!));
    assert.deepEqual(inspectNpc("NPC", "male"), male, "template assignment is stable on render/reload");
    assert.deepEqual(inspectNpc("NPC", "female"), { label: "NPC", sprite: "@asset:female-a" });
    assert.deepEqual(inspectNpc("NPC", "unknown"), { label: "NPC", sprite: null });
    assert.deepEqual(inspectNpc("Narrator", "male"), { label: null, sprite: null });
    assert.equal(inspectNpc("阿璃", "female").sprite, null, "defined speakers never borrow NPC fallback art");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "React", descriptor);
    else Reflect.deleteProperty(globalThis, "React");
  }
});

test("VN stage keeps recent configured speakers, expressions and scene boundaries", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const names = ["Evelia", "Miveth", "Yui", "Minori", "Kei"];
  const api = {
    variables: { "vn-sprites": Object.fromEntries(names.map(name => [name, { normal: `@asset:${name}`, happy: `@asset:${name}-happy` }])) },
    resolveAssetUrl: (ref: string) => ref,
    readLines: names.map(name => ({ name, emotion: "normal", scene: "hall" })),
    limit: 1,
  };
  const result = bundleAndCompile({ files: { ...files, "probe.tsx": 'import { sceneSprites } from "./sprites"; export default function Probe(){ const api=useYumina(); return <pre>{JSON.stringify(typeof sceneSprites === "function" ? sceneSprites(api,api.readLines,api.limit) : [])}</pre> }' }, entryFile: "probe.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const inspect = async () => {
    await act(async () => root.render(createElement(result.Component!)));
    return JSON.parse(container.textContent!) as Array<{ name: string; emotion: string; src: string }>;
  };
  try {
    assert.deepEqual((await inspect()).map(sprite => sprite.name), ["Kei"], "portrait keeps only the current speaker");
    api.limit = 4;
    assert.deepEqual((await inspect()).map(sprite => sprite.name), ["Miveth", "Yui", "Minori", "Kei"], "landscape and desktop keep at most four, including the current speaker");
    api.readLines.push({ name: "Evelia", emotion: "happy", scene: "hall" }, { name: "", emotion: "normal", scene: "hall" });
    const updated = await inspect();
    assert.deepEqual(updated.map(sprite => sprite.name), ["Evelia", "Yui", "Minori", "Kei"], "retained characters keep stable encounter ordering");
    assert.equal(updated[0].src, "@asset:Evelia-happy", "the latest read expression is shown during narration too");
    api.readLines = api.readLines.slice(0, 1);
    assert.deepEqual((await inspect()).map(sprite => sprite.name), ["Evelia"], "unread future speakers never appear when browsing backward");
    api.readLines.push({ name: "Miveth", emotion: "unconfigured", scene: "garden" });
    assert.deepEqual(await inspect(), [{ name: "Miveth", emotion: "normal", src: "@asset:Miveth" }], "a new scene clears the old cast and missing expressions use normal");
    api.readLines.push({ name: "Unknown", emotion: "normal", scene: "garden" });
    assert.equal((await inspect()).length, 1, "a portrait or unknown speaker cannot invent a sprite asset");
    api.readLines.push({ name: "", emotion: "normal", scene: "empty-room" });
    assert.deepEqual(await inspect(), [], "a scene change clears sprites even on a narrator page");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("VN advances narration and dialogue, sends only selected choice, and keeps traces in log", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const sent: string[] = [];
  let saves = 0, loads = 0, savedName = "", restored = "", continued = 0, browserFullscreen = 0, immersive = 0;
  const storage = new Map<string, string>();
  const text = '*Miveth opens the door.*\n\nMiveth: "hey so \\*I\\* did this"\n\n*She smiles.*';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This fixture replaces SDK channels dynamically to exercise completed, failed and streaming turns.
  const api: any = {
    sessionId: "test", worldId: "world", variables: {}, entries: [{ name: "Miveth", role: "character" }],
    messages: [{ id: "m1", role: "assistant", content: text, swipes: [{ content: text, reasoningContent: "Saved trace." }] }],
    pendingChoices: ["Wait here", "Follow her"], isStreaming: false, streamingContent: "", greetingContent: null,
    checkpoints: [{ id: "save1", name: "Chapter 1", messageCount: 1, createdAt: "2026-10-03T01:00:00Z" }],
    storage: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, value: string) => { storage.set(key, value); } },
    renderMarkdown: (s: string) => s.replace(/\\\*/g, "*").replace(/\*([^*]+)\*/g, "<em>$1</em>"), resolveAssetUrl: (s: string) => s,
    sendMessage: (s: string) => sent.push(s), continueLastMessage: () => continued++,
    saveCheckpoint: async (name?: string) => { saves++; savedName = name ?? "Checkpoint #1"; }, loadCheckpoints: async () => { loads++; return api.checkpoints; }, restoreCheckpoint: async (id: string) => { restored = id; },
    getAudioVolume: () => 0.5, setAudioVolume: () => {}, showToast: () => {}, navigate: () => {},
    isImmersive: true, systemFullscreen: false, canSystemFullscreen: true,
    toggleSystemFullscreen: async () => { browserFullscreen++; }, toggleImmersive: () => { immersive++; },
  };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api, {
    SessionMemoryModal: ({ open, initialTab, onClose }) => open ? createElement("section", {
      role: "dialog", "aria-label": "Memory inspector", "data-tab": initialTab,
    }, createElement("button", { onClick: onClose as () => void }, "Close memory")) : null,
  });
  assert.equal(result.error, null, result.error ?? undefined);
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
    assert.ok(button, "Missing button " + label);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(result.Component!)));
    assert.match(container.querySelector(".vn-dialogue")!.textContent!, /Miveth opens the door/);
    assert.equal(container.querySelector(".vn-name")!.textContent, "");
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 0, "choices wait until all passages read");
    await click("Advance story");
    assert.equal(container.querySelector(".vn-name")!.textContent, "Miveth");
    assert.match(container.querySelector(".vn-dialogue")!.textContent!, /hey so I did this/);
    await click("Advance story");
    assert.equal(container.querySelector(".vn-name")!.textContent, "");
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 2);
    await click("Log");
    assert.match(container.querySelector(".vn-log")!.textContent!, /Miveth opens the door/);
    assert.equal(container.querySelectorAll(".vn-log .vn-narration").length, 2);
    assert.ok(container.querySelector(".vn-thinking")!.compareDocumentPosition(container.querySelector(".vn-narration")!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the optional Thinking toggle comes before its reply");
    assert.ok(!container.textContent!.includes("Saved trace."));
    await click("Thinking");
    assert.ok(container.textContent!.includes("Saved trace."));
    await click("Close log");
    const stage = container.querySelector<HTMLButtonElement>('.vn-stage')!;
    stage.focus();
    await act(async () => stage.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "2", bubbles: true })));
    assert.deepEqual(sent, ["Follow her"]);
    assert.equal(continued, 0);
    assert.equal(container.querySelector('.vn-text')!.textContent, 'Follow her', 'the submitted choice is displayed as the persona passage');
    api.isStreaming = true;
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector('.vn-text')!.textContent, 'Follow her', 'streaming keeps the selected persona line visible');
    api.isStreaming = false;
    api.messages.push({ id: 'choice-1', role: 'user', content: 'Follow her' }, { id: 'reply-1', role: 'assistant', content: '[SPEAKER:Miveth:normal] "Come along."' });
    api.pendingChoices = ["Next"];
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector('.vn-text')!.textContent, 'Follow her', 'a completed reply waits behind the chosen line for the player to advance');
    assert.equal(container.querySelectorAll('.vn-choice').length, 0, 'next-turn choices remain hidden until the reply is revealed');
    assert.equal(container.querySelectorAll('[role="status"]').length, 0, 'a completed reply stops the loader while retaining the persona passage');
    await click('Advance story');
    assert.equal(container.querySelector('.vn-text')!.textContent, 'Come along.', 'the player click reveals the first NPC response passage');
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 1);
    api.pendingChoices = [];
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelectorAll(".vn-custom-choice").length, 1);
    await click("Advance story");
    await act(async () => container.querySelector<HTMLElement>(".vn-dialogue")!.click());
    for (const key of [" ", "Enter"]) {
      stage.focus();
      await act(async () => stage.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })));
    }
    await click("Skip");
    await click("Auto");
    assert.equal(continued, 0, "reading the final passage never starts a continuation when only the custom choice remains");
    assert.deepEqual(sent, ["Follow her"]);
    assert.equal(container.querySelectorAll('[role="status"]').length, 0, "end-of-passage clicks never start a loader");
    await click("Write your own choice");
    await click("Close composer");
    assert.equal(continued, 0, "opening or dismissing the composer never continues the story");
    await click("Auto");
    await click("Menu");
    const memoryReadingPosition = container.querySelector(".vn-progress")!.textContent;
    await click("Memory");
    const memoryInspector = container.querySelector('[aria-label="Memory inspector"]');
    assert.ok(memoryInspector, "the VN menu opens the platform memory inspector without installing the legacy extension");
    assert.equal(memoryInspector.getAttribute("data-tab"), "storyhaven", "memory opens directly to the story memory inspector");
    assert.equal(container.querySelector('[aria-label="Story menu"]'), null, "the inspector replaces the VN menu while open");
    for (const key of [" ", "Enter", "1", "Escape", "Tab"]) {
      const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => memoryInspector.dispatchEvent(event));
      assert.equal(event.defaultPrevented, false, "VN shortcuts defer to the inspector: " + key);
    }
    assert.equal(container.querySelector(".vn-progress")!.textContent, memoryReadingPosition);
    assert.deepEqual(sent, ["Follow her"], "inspecting memory never sends a player turn");
    assert.equal(continued, 0, "inspecting memory never generates a continuation");
    await click("Close memory");
    assert.ok(container.querySelector('[aria-label="Story menu"]'), "closing memory returns to the VN menu");
    assert.ok(document.activeElement === container.querySelector(".vn-menu-memory"), "closing memory returns focus to its VN menu entry");
    await click("Browser fullscreen");
    assert.equal(browserFullscreen, 1, "browser fullscreen lives in the VN menu");
    await click("Windowed view");
    assert.equal(immersive, 1, "windowed view uses the existing immersive toggle");
    await click("Save");
    assert.equal(saves, 0, "opening Save only opens the naming modal");
    assert.equal(container.querySelector<HTMLInputElement>("#vn-checkpoint-name")!.value, "Checkpoint #1");
    await click("Save");
    assert.equal(saves, 1);
    assert.equal(savedName, "Checkpoint #1");
    await click("Load");
    assert.equal(loads, 2);
    await click("Chapter 1");
    assert.equal(restored, "save1");
    assert.deepEqual(sent, ["Follow her"], "thinking and save/load never become model input");
    api.entries = [{ name: "NPC: Miveth", role: "character" }];
    api.variables = { segments: [{ speaker: "Miveth", text: '"Hello."' }] };
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-name")!.textContent, "Miveth", "official segments use character display names");
    api.variables = { segments: [{ speaker: "Clerk", text: "Welcome to the academy." }] };
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-name")!.textContent, "NPC", "undefined structured speakers use NPC even without quotes");
    api.entries = [{ name: "Miveth", role: "character", portrait: "@asset:portrait" }, { name: "Evelia", role: "character" }];
    api.variables = { "vn-sprites": { Miveth: { happy: "@asset:happy", normal: "@asset:normal" } } };
    api.messages = [{ id: "m2", role: "assistant", content: '[SPEAKER:Miveth:happy] "hey so *I* did this" **Miveth lowers the cup.** [Name:Evelia:shy] "Wait."', swipes: [{ choices: ["Answer her", "Leave"] }] }];
    api.pendingChoices = [];
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-name")!.textContent, "Miveth");
    assert.equal(container.querySelector(".vn-text")!.textContent, "hey so I did this");
    assert.equal(container.querySelector(".vn-sprite")!.getAttribute("src"), "@asset:happy");
    api.isStreaming = true;
    api.streamingContent = '[SPEAKER:Evelia:angry] "PARTIAL_TEXT_MUST_NOT_APPEAR"';
    api.streamingReasoning = "PARTIAL_TRACE_MUST_NOT_APPEAR";
    api.variables = { segments: [{ speaker: "Evelia", text: "PARTIAL_SEGMENT_MUST_NOT_APPEAR" }] };
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-name")!.textContent, "Miveth");
    assert.equal(container.querySelector(".vn-sprite")!.getAttribute("src"), "@asset:happy", "streaming never changes the completed scene's cast or expression");
    assert.ok(container.querySelector('[role="status"] .vn-spinner'));
    await click("Log");
    assert.doesNotMatch(container.textContent!, /PARTIAL_/);
    api.error = "The provider timed out.";
    api.messages.push({ id: "failed", role: "user", status: "failed", content: "Leave" });
    await act(async () => root.render(createElement(result.Component!)));
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /provider timed out/);
    assert.equal(container.querySelectorAll('[role="status"]').length, 0, "errors stop the loader even if stream state lags");
    api.isStreaming = false;
    await act(async () => root.render(createElement(result.Component!)));
    await click("Retry");
    assert.equal(continued, 1, "retry uses the existing failed-turn path");
    assert.deepEqual(sent, ["Follow her"], "retry never duplicates player input");
    api.error = null; api.isStreaming = true;
    await act(async () => root.render(createElement(result.Component!)));
    assert.ok(container.querySelector('[role="status"] .vn-spinner'), "a new retry is not blocked by the stale failed row");
    api.isStreaming = false;
    await click("Close log");
    api.error = null;
    api.messages.pop();
    api.variables = {};
    api.sendFailureNonce = 1;
    await act(async () => root.render(createElement(result.Component!)));
    await click("Advance story");
    assert.equal(container.querySelector(".vn-name")!.textContent, "");
    assert.ok(container.querySelector(".vn-text.vn-action"), "starred actions are italic narration");
    assert.match(container.querySelector(".vn-text")!.textContent!, /Miveth lowers the cup/);
    await click("Advance story");
    assert.equal(container.querySelector(".vn-name")!.textContent, "Evelia");
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 2, "saved swipe choices work after reload");
    const beforeComposer = sent.length;
    await click("Write your own choice");
    const textbox = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your choice"]');
    assert.ok(textbox, "custom choice opens a modal composer");
    await click("Close composer");
    assert.equal(sent.length, beforeComposer, "dismissal sends nothing");
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 2);
    assert.equal(container.querySelectorAll(".vn-custom-choice").length, 1);
    await click("Write your own choice");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your choice"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "I ask Miveth about the cup.");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Send choice");
    assert.equal(sent.at(-1), "I ask Miveth about the cup.");
    assert.equal(container.querySelectorAll('textarea').length, 0);
    const probe = bundleAndCompile({ files: { ...files, "probe.tsx": 'import { passages } from "./passages"; export default function Probe(){ const api=useYumina(); return <pre>{JSON.stringify(passages(api.entries,api.testText))}</pre> }' }, entryFile: "probe.tsx" }, () => api);
    assert.equal(probe.error, null);
    api.testText = '*Miveth looks away.* "Hello," she says. "Wait."';
    await act(async () => root.render(createElement(probe.Component!)));
    const untagged: Passage[] = JSON.parse(container.textContent!);
    assert.equal(untagged.filter(p => p.kind === "dialogue").length, 2, "separate quotes survive unattributed legacy prose");
    assert.deepEqual(untagged.map(p => p.name), ["", "Miveth", "", "Miveth"], "an adjacent singular pronoun speech attribution can refer to a uniquely named subject");
    api.testText = '*Miveth watches the player.*\n\n*Evelia\'s hand trembles. Hope flickers in her eyes.*\n\n"You... you\'re not angry?" *she asks, barely above a whisper.* "I know this is strange."';
    await act(async () => root.render(createElement(probe.Component!)));
    const recovered: Passage[] = JSON.parse(container.textContent!);
    assert.deepEqual(recovered.filter(p => p.kind === "dialogue").map(p => p.name), ["Evelia", "Evelia"]);
    assert.ok(recovered.filter(p => p.kind === "narration").every(p => p.name === ""));
    const greetingSpeech = '"Thank you for coming," *Evelia says, voice soft, measured, almost too careful. She gestures to the chair opposite her.* "I... had the kitchens prepare something special. Please, sit. It\'s been so long since we\'ve had a quiet evening."';
    api.testText = greetingSpeech;
    await act(async () => root.render(createElement(probe.Component!)));
    const greetingPassages: Passage[] = JSON.parse(container.textContent!);
    assert.deepEqual(greetingPassages.map(p => [p.name, p.kind]), [["Evelia", "dialogue"], ["", "narration"], ["Evelia", "dialogue"]], "the opening's named speech attribution survives its narrator action");
    assert.equal(greetingPassages[2].text, "I... had the kitchens prepare something special. Please, sit. It's been so long since we've had a quiet evening.");
    const missingMarkers = '"M-miveth, you\'re always welcome," *Evelia says, her voice soft, too quick, tail sweeping low behind her.* "I was just... sharing a drink."\n\n*A half-step is all Miveth takes. The tip of her tail flicks once.*\n\n"An evening." *The words carry no accusation, only uncertainty. A pause. Then,* "What are you drinking, Evelia?"\n\n*Silence fills the room. Evelia\'s golden eyes go wide.*';
    api.testText = missingMarkers;
    await act(async () => root.render(createElement(probe.Component!)));
    const missingMarkerPassages: Passage[] = JSON.parse(container.textContent!);
    assert.deepEqual(missingMarkerPassages.filter(p => p.kind === "dialogue").map(p => [p.name, p.text]), [
      ["Evelia", "M-miveth, you're always welcome,"], ["Evelia", "I was just... sharing a drink."],
      ["Miveth", "An evening."], ["Miveth", "What are you drinking, Evelia?"],
    ], "the named action subject supplies the next quote run; a spoken addressee never steals it");
    assert.ok(missingMarkerPassages.filter(p => p.kind === "narration").every(p => !p.name));
    api.messages = [{ id: "missing-markers", role: "assistant", content: missingMarkers }];
    await act(async () => root.render(createElement(result.Component!)));
    await click("Log");
    assert.deepEqual(Array.from(container.querySelectorAll(".vn-log-row .vn-speaker-name")).map(node => node.textContent), ["Evelia", "Evelia", "Miveth", "Miveth"]);
    await click("Close log");
    api.messages = [{ id: "unknown-voice", role: "assistant", content: '*The room is quiet.*\n\n"Who is there?"' }];
    await act(async () => root.render(createElement(result.Component!)));
    await click("Advance story");
    assert.equal(container.querySelector(".vn-name")?.textContent, "NPC", "unattributed speech has an NPC label in the VN stage");
    await click("Log");
    assert.equal(container.querySelector(".vn-log-copy")?.textContent, "Who is there?", "unassigned quoted speech remains upright dialogue");
    assert.equal(container.querySelector(".vn-log-speaker .vn-speaker-name")?.textContent, "NPC", "unattributed speech has an NPC label in the log");
    assert.equal(container.querySelectorAll(".vn-log-speaker img,.vn-log-speaker .vn-avatar").length, 0, "unknown speech never invents a portrait");
    assert.ok(!Array.from(container.querySelectorAll(".vn-narration")).some(node => node.textContent?.includes("Who is there?")));
    await click("Close log");
    api.testText = '[SPEAKER:Clerk:normal] "Name?" *The clerk opens the ledger.* "Previous education?"';
    await act(async () => root.render(createElement(probe.Component!)));
    const incidental = JSON.parse(container.textContent!) as (Passage & { portrait: string | null })[];
    assert.deepEqual(incidental.map(p => [p.name, p.kind]), [["NPC", "dialogue"], ["", "narration"], ["NPC", "dialogue"]], "an explicit undefined speaker is labeled NPC without a character entry");
    assert.ok(incidental.every(p => p.portrait === null), "an explicit NPC name never borrows another character's portrait");
    const previousEntries = api.entries;
    api.entries = [...api.entries, { name: "Clerk", role: "character", portrait: "@asset:clerk" }];
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as (Passage & { portrait: string | null })[]).filter(p => p.kind === "dialogue").map(p => [p.name, p.portrait]), [["Clerk", "@asset:clerk"], ["Clerk", "@asset:clerk"]], "a registered Clerk keeps its defined name and portrait");
    api.entries = previousEntries;
    for (const [name, alias] of [["Sera (Seraphine)", "Sera"], ["Sera (Seraphine)", "Seraphine"], ["Ryu (Ryutharax)", "Ryutharax"], ["Lilith Vexthorne", "Lilith"], ["Diane Bluerose", "Diane"], ["阿璃 (Ari)", "阿璃"], ["A+B Scholar", "A+B"]]) {
      api.entries = [...previousEntries, { name, role: "character", portrait: "@asset:defined-character" }];
      api.testText = `*${alias} says* "Welcome."`;
      await act(async () => root.render(createElement(probe.Component!)));
      assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), [name], "every defined character uses the same generic name resolver");
    }
    api.entries = previousEntries;
    api.testText = '[SPEAKER:NPC:happy] Welcome. *The clerk opens the ledger.* [SPEAKER:Miveth:normal] "Hello."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).map(p => [p.name, p.kind]), [["NPC", "dialogue"], ["", "narration"], ["Miveth", "dialogue"]], "explicit NPC speech remains dialogue and does not replace a defined character");
    api.entries = [...previousEntries, { name: "Diane (Bluerose)", role: "character", portrait: "@asset:diane" }];
    for (const text of [
      '*Diane says* "Hmph, stupid peasants blocking my path."',
      '"Hmph," Diane says.',
      '"Hmph," says Diane.',
      'Diane: "Hmph."',
      '[SPEAKER:Diane:angry] "Hmph."',
      '*Diane steps forward.* "Hmph."',
      '*Diane (Bluerose) steps forward.* "Hmph."',
    ]) {
      api.testText = text;
      await act(async () => root.render(createElement(probe.Component!)));
      const spoken = (JSON.parse(container.textContent!) as (Passage & { portrait: string | null })[]).filter(p => p.kind === "dialogue");
      assert.deepEqual(spoken.map(p => [p.name, p.portrait]), [["Diane (Bluerose)", "@asset:diane"]], "a unique short name resolves to the defined character and asset key");
    }
    api.testText = '"Next. Name. Now."\n\n*Diane says* "Hmph, stupid peasants blocking my path."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), ["NPC", "Diane (Bluerose)"], "the next paragraph's attribution cannot claim the previous NPC's dialogue");
    api.entries.push({ name: "Diane (Redrose)", role: "character", portrait: "@asset:other-diane" });
    api.testText = '*Diane says* "Hmph."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), ["NPC"], "an ambiguous short name never selects one of two defined characters");
    api.testText = '[SPEAKER:Diane (Bluerose):angry] "Hmph."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), ["Diane (Bluerose)"], "full names remain usable when short names collide");
    api.entries = previousEntries;
    for (const text of [
      '"Thank you," *Evelia says softly.*\n\n"I prepared something."',
      '"Thank you," *Evelia says softly.* *Unknown says softly.* "I prepared something."',
    ]) {
      api.testText = text;
      await act(async () => root.render(createElement(probe.Component!)));
      assert.equal((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").at(-1)!.name, "NPC", "paragraph boundaries and unrelated or unknown actors use NPC instead of inheriting a character");
    }
    for (const text of [
      '*Evelia watches Miveth.*\n\n"You... you\'re not angry?" *she asks.*',
      '*Evelia stands still.*\n\n*The player lifts the cup.*\n\n"Hello." *she says.*',
      '*Evelia stands still.*\n\n"Hello." *they say.*',
      '*Evelia stands still.*\n\n"Hello." *Unknown asks.*',
      '*Miveth steps inside.* *The guard enters.* "Hello."',
      '*Miveth steps inside.* *{{user}} lift the cup.* "Hello."',
      '*Miveth and Evelia enter together.* "Hello."',
    ]) {
      api.testText = text;
      await act(async () => root.render(createElement(probe.Component!)));
      assert.ok((JSON.parse(container.textContent!) as Passage[]).every(p => p.name === (p.kind === "dialogue" ? "NPC" : "")), "ambiguous pronouns and missing attribution use NPC without inventing a character");
    }
    api.testText = '"Hi," Miveth asks. *Evelia looks away.* "No."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), ["Miveth", "Evelia"], "an intervening named actor replaces the earlier speaker");
    for (const [text, names] of [
      ['*Evelia stands still.*\n\n"Hello."', ["Evelia"]],
      ['"Thank you," *Evelia says softly.* *Miveth looks at the door.* "I prepared something."', ["Evelia", "Miveth"]],
      ['**Miveth steps inside.**\n\n"Evelia, wait." *The words echo in the hall.* "Please."', ["Miveth", "Miveth"]],
    ] as const) {
      api.testText = text;
      await act(async () => root.render(createElement(probe.Component!)));
      assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => p.name), names);
    }
    api.testText = '[SPEAKER:Miveth:happy] "Hello," *Evelia says.*\n\n*Evelia steps back.* "Wait."\n[Name:Evelia:shy] "Fine."';
    await act(async () => root.render(createElement(probe.Component!)));
    assert.deepEqual((JSON.parse(container.textContent!) as Passage[]).filter(p => p.kind === "dialogue").map(p => [p.name, p.emotion]), [["Miveth", "happy"], ["Miveth", "happy"], ["Evelia", "shy"]], "explicit VN markers override conflicting prose until the next marker");
    api.testText = '[SPEAKER:Miveth:happy] "The literal [Name:Evelia:angry] stays here."\nNarrator: *Miveth says quietly.*\nEvelia: "No."';
    await act(async () => root.render(createElement(probe.Component!)));
    const tagged: Passage[] = JSON.parse(container.textContent!);
    assert.deepEqual(tagged.map(p => p.name), ["Miveth", "", "Evelia"]);
    assert.match(tagged[0].text, /\[Name:Evelia:angry\]/, "quoted marker-like text remains literal");
    assert.equal(tagged[0].emotion, "happy");
    api.messages = [{ id: "greeting", role: "assistant", content: "The opening scene.", status: "failed" }];
    api.variables = {};
    api.error = "A test error on the opening message.";
    await act(async () => root.render(createElement(result.Component!)));
    assert.ok(container.querySelector('[role="alert"]'), "opening errors remain visible");
    assert.ok(!Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Retry"), "the first message never has Retry");
    api.error = null;
    api.user = { name: "Robin", avatar: "@asset:persona" };
    api.messages = [{ id: "player-choice", role: "user", content: "I wait here." }, { id: "player-scene", role: "assistant", content: "**{{user}} look at Evelia. {{user}}'s hand is steady.**" }];
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-text")!.textContent, "Robin looks at Evelia. Robin's hand is steady.");
    assert.equal(api.messages[1].content, "**{{user}} look at Evelia. {{user}}'s hand is steady.**", "persona display never rewrites saved history");
    await click("Log");
    assert.equal(container.querySelector(".choice .vn-speaker-name")!.textContent, "Robin (You)");
    assert.equal(container.querySelector(".choice img")!.getAttribute("src"), "@asset:persona");
    assert.match(container.querySelector(".vn-narration")!.textContent!, /Robin looks at Evelia\. Robin's hand is steady/);
    await click("Close log");
    api.messages = [
      { id: "opening", role: "assistant", content: '*Evelia enters.*\n\nEvelia: "Hello."' },
      { id: "player-choice", role: "user", content: "I wait here." },
      { id: "ending", role: "assistant", content: '*Evelia waits.*' },
    ];
    api.pendingChoices = ["Answer", "..."];
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector(".vn-progress")!.textContent, "Turn 2 | Page 1 of 1");
    assert.equal(container.querySelectorAll(".vn-continue").length, 0, "the final page has no continuation indicator");
    const wheelPage = async (deltaY: number) => {
      await new Promise(resolve => setTimeout(resolve, 260));
      await act(async () => container.querySelector(".vn-stage")!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true })));
    };
    const beforeReading = { continued, sent: sent.length };
    await wheelPage(-100);
    assert.equal(container.querySelector(".vn-progress")!.textContent, "Turn 1 | Page 2 of 2");
    assert.ok(container.querySelector(".vn-continue"), "a later generated turn is available to read");
    assert.equal(container.querySelectorAll(".vn-choice").length, 0, "old turns never offer current choices");
    await wheelPage(-100);
    assert.equal(container.querySelector(".vn-progress")!.textContent, "Turn 1 | Page 1 of 2");
    await wheelPage(-100);
    assert.equal(container.querySelector(".vn-progress")!.textContent, "Turn 1 | Page 1 of 2", "scrolling stops at the opening");
    await wheelPage(100);
    await wheelPage(100);
    assert.equal(container.querySelector(".vn-progress")!.textContent, "Turn 2 | Page 1 of 1");
    await wheelPage(100);
    assert.deepEqual({ continued, sent: sent.length }, beforeReading, "wheel navigation, including both boundaries, never generates");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
