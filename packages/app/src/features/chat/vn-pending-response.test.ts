import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradeVnLoadingFiles } from "./vn-loading-progress";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = existsSync(source)
  ? Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]))
  : {};

function installDom(dom: JSDOM) {
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fixtures model mutable SDK updates during a reply.
async function setup(api: any, cardFiles = files) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore = installDom(dom);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const result = bundleAndCompile({ files: cardFiles, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  return { dom, restore, root, container, render };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  assert.ok(button, `Missing button ${label}`);
  return button;
}

function makeApi() {
  const oldContent = '[SPEAKER:Miveth:normal] "The old reply."';
  const oldAssistant = {
    id: "assistant-old", role: "assistant", status: "complete", content: oldContent,
    swipes: [{ content: oldContent, choices: ["Wait", "Ask", "Leave", "Help"] }], activeSwipeIndex: 0,
  };
  const pendingUser = { id: "user-pending", role: "user", status: "complete", content: "I choose this." };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Simulate the live SDK without invoking provider or session mutations.
  const api: any = {
    sessionId: "pending-test", worldId: "world", worldName: "Academy", variables: {}, entries: [{ name: "Miveth", role: "character" }],
    messages: [oldAssistant, pendingUser], pendingChoices: [], isStreaming: false, streamingContent: "", greetingContent: null,
    hasEarlierMessages: false, readOnly: false, error: null,
    storage: { get: async () => null, set: async () => {} },
    renderMarkdown: (s: string) => s, resolveAssetUrl: (s: string) => s,
    sendMessage: () => { throw new Error("pending response must not send another user message"); },
    retryPendingReply: (id: string) => { api.retryCalls++; api.retryTargets.push(id); api.isStreaming = true; },
    deleteMessage: (id: string) => {
      api.deleteCalls.push(id);
      api.messages = [oldAssistant];
      api.pendingChoices = ["Wait", "Ask", "Leave", "Help"];
      return true;
    },
    retryCalls: 0,
    retryTargets: [] as string[],
    deleteCalls: [] as string[],
  };
  return { api, oldAssistant, pendingUser };
}

const sceneFiles = {
  ...files,
  "scenes.ts": files["scenes.ts"]
    .replace('export const scenes = {};', 'export const scenes = { dormroom: "dormroom.png", library: "library.png" };')
    .replace('export const openingScenes = {};', 'export const openingScenes = { enrollment: { opening: "greeting.png" } };'),
};

test("VN loading shows live generation progress while the story stays buffered", async () => {
  const fixture = makeApi();
  const view = await setup(fixture.api);
  try {
    fixture.api.isStreaming = true;
    fixture.api.streamingTokenCount = 0;
    await view.render();
    assert.match(view.container.querySelector('.vn-status')?.textContent ?? "", /0 tokens/);
    fixture.api.streamingTokenCount = 128;
    await view.render();
    assert.match(view.container.querySelector('.vn-status')?.textContent ?? "", /~128 tokens/);
    fixture.api.streamingTokenCount = 256;
    await view.render();
    assert.match(view.container.querySelector('.vn-status')?.textContent ?? "", /~256 tokens/);
    assert.equal(view.container.querySelector('.vn-text')?.textContent, "The old reply.");
    fixture.api.error = "Provider failed";
    fixture.api.isStreaming = false;
    await view.render();
    assert.equal(view.container.querySelector('.vn-status'), null);
    fixture.api.error = null;
    fixture.api.isStreaming = true;
    fixture.api.streamingTokenCount = null;
    await view.render();
    assert.match(view.container.querySelector('.vn-status')?.textContent ?? "", /0 tokens/);
    fixture.api.isStreaming = false;
    await view.render();
    assert.equal(view.container.querySelector('.vn-status'), null);
  } finally {
    await act(async () => view.root.unmount()); view.dom.window.close(); view.restore();
  }
});

test("saved VN cards get live loading progress without changing authored files", async () => {
  const saved: Record<string, string> = { ...files, "index.tsx": files["index.tsx"].replace('import { LoadingStatus } from "./loading-status";\n', '').replace('<LoadingStatus api={api} />', '<div className="vn-status" role="status"><span className="vn-spinner" aria-hidden="true" /><span>Loading…</span></div>') };
  delete saved["loading-status.tsx"];
  const fixture = makeApi();
  fixture.api.isStreaming = true;
  fixture.api.streamingTokenCount = 128;
  const upgraded = upgradeVnLoadingFiles(saved, files["loading-status.tsx"]!);
  const view = await setup(fixture.api, upgraded);
  try {
    await view.render();
    assert.match(view.container.querySelector('.vn-status')?.textContent ?? "", /~128 tokens/);
    assert.equal(saved["loading-status.tsx"], undefined);
    for (const [name, content] of Object.entries(saved)) if (name !== "index.tsx") assert.equal(upgraded[name], content);
    assert.equal(upgradeVnLoadingFiles(upgraded, files["loading-status.tsx"]!), upgraded, "loading upgrades are idempotent");
    const authored = { "index.tsx": 'const api = useYumina(); export default function Card(){return <p>My own loading UI</p>}' };
    assert.equal(upgradeVnLoadingFiles(authored, files["loading-status.tsx"]!), authored);
  } finally {
    await act(async () => view.root.unmount()); view.dom.window.close(); view.restore();
  }
});

test("a submitted choice retains the reached background until the next reply is opened", async () => {
  const fixture = makeApi();
  const content = '[SCENE:dormroom]\n[SPEAKER:Miveth:normal] "Rest here."';
  fixture.oldAssistant.content = content;
  fixture.oldAssistant.swipes = [{ content, choices: ["Drink the tea and rest"] }];
  fixture.api.messages = [fixture.oldAssistant];
  fixture.api.entries.push({ id: "enrollment", role: "greeting" });
  fixture.api.pendingChoices = ["Drink the tea and rest"];
  fixture.api.getPersonaControlMode = async () => "player";
  fixture.api.classifyPlayerExpression = async () => "normal";
  fixture.api.sendMessage = (text: string) => {
    fixture.api.messages.push({ id: "next-user", role: "user", content: text });
    fixture.api.isStreaming = true;
  };
  const view = await setup(fixture.api, sceneFiles);
  const background = () => view.container.querySelector('.vn-bg')?.getAttribute("src");
  try {
    await view.render();
    assert.equal(background(), "dormroom.png");
    await act(async () => findButton(view.container, "Drink the tea and rest").click());
    await view.render();
    assert.equal(background(), "dormroom.png", "the temporary choice must not fall back to the greeting");
    fixture.api.isStreaming = false;
    fixture.api.messages.push({ id: "next-answer", role: "assistant", content: '[SCENE:library]\n*The next morning, you arrive at the library.*' });
    await view.render();
    assert.equal(background(), "dormroom.png", "an unread reply cannot change the choice background");
    await act(async () => findButton(view.container, "Advance story").click());
    assert.equal(background(), "library.png");
  } finally {
    await act(async () => view.root.unmount()); view.dom.window.close(); view.restore();
  }
});

test("untagged reply pages inherit the previous scene without applying a future scene early", async () => {
  const fixture = makeApi();
  const previous = '[SCENE:dormroom]\n*Kei sets down the tea.*';
  fixture.oldAssistant.content = previous;
  fixture.oldAssistant.swipes = [{ content: previous, choices: [] }];
  fixture.api.entries.push({ id: "enrollment", role: "greeting" });
  fixture.api.messages = [fixture.oldAssistant, fixture.pendingUser, {
    id: "next-answer", role: "assistant", content: '*Kei hands you the cup.*\n[SCENE:library]\n*The next morning, you arrive at the library.*',
  }];
  const view = await setup(fixture.api, sceneFiles);
  const background = () => view.container.querySelector('.vn-bg')?.getAttribute("src");
  try {
    await view.render();
    assert.equal(background(), "dormroom.png", "a missing scene tag continues the last location");
    await act(async () => findButton(view.container, "Advance story").click());
    assert.equal(background(), "library.png");
    await act(async () => view.container.querySelector('.vn')!.dispatchEvent(new view.dom.window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })));
    assert.equal(background(), "dormroom.png", "rewinding restores the scene at that page");
  } finally {
    await act(async () => view.root.unmount()); view.dom.window.close(); view.restore();
  }
});

test("VN exposes pending-response recovery instead of stale choices", async () => {
  const fixture = makeApi();
  const view = await setup(fixture.api);
  try {
    await view.render();
    assert.match(view.container.textContent ?? "", /pending|response|retry/i);
    assert.ok(findButton(view.container, "Retry response"));
    assert.ok(findButton(view.container, "Choose something else"));
    assert.equal(view.container.querySelectorAll(".vn-choice:not(.vn-custom-choice):not(.vn-retry-response):not(.vn-change-choice)").length, 0, "old assistant choices stay hidden");
    const retry = findButton(view.container, "Retry response");
    await act(async () => { retry.click(); retry.click(); });
    assert.equal(fixture.api.retryCalls, 1);
    assert.deepEqual(fixture.api.retryTargets, ["user-pending"]);
    assert.equal(fixture.api.messages.length, 2);
    assert.deepEqual(fixture.api.deleteCalls, []);
    assert.equal(view.container.querySelectorAll('[aria-label="Write your own choice"]').length, 0, "retry does not send a duplicate choice");
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("VN pending response hides controls while loading and restores choices after choosing something else", async () => {
  const fixture = makeApi();
  const view = await setup(fixture.api);
  try {
    fixture.api.isStreaming = true;
    await view.render();
    assert.equal(view.container.querySelector('.vn-retry-response'), null);
    assert.equal(view.container.querySelector('.vn-change-choice'), null);
    fixture.api.isStreaming = false;
    await view.render();
    await act(async () => findButton(view.container, "Choose something else").click());
    assert.deepEqual(fixture.api.deleteCalls, ["user-pending"]);
    await view.render();
    assert.equal(view.container.querySelector('.vn-retry-response'), null);
    assert.equal(view.container.querySelector('.vn-change-choice'), null);
    assert.deepEqual(Array.from(view.container.querySelectorAll(".vn-choice:not(.vn-custom-choice)")).map(node => node.textContent?.trim()), ["Wait", "Ask", "Leave", "Help"]);
    assert.equal(view.container.querySelectorAll(".vn-custom-choice").length, 1);
    assert.equal(view.container.querySelector('.vn-generate-choices'), null, "existing choices suppress recovery generation");
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("a pending player choice pages through action and speech while retaining its persona sprite", async () => {
  const fixture = makeApi();
  const choice = 'Flash a confident grin and place 100 gold coins on the counter. "Is this enough for now?"';
  fixture.api.messages = [fixture.oldAssistant];
  fixture.api.pendingChoices = [choice];
  fixture.api.user = { name: "Aelorian Myrren", avatar: "persona.png", sprites: { normal: "persona-normal.png", happy: "persona-happy.png" } };
  fixture.api.getPersonaControlMode = async () => "player";
  fixture.api.classifyPlayerExpression = async () => "happy";
  const sent: string[] = [];
  fixture.api.sendMessage = (text: string) => { sent.push(text); fixture.api.messages.push({ id: "new-user", role: "user", content: text }); fixture.api.isStreaming = true; };
  const view = await setup(fixture.api);
  const advance = async () => { await act(async () => findButton(view.container, "Advance story").click()); };
  try {
    await view.render();
    await act(async () => findButton(view.container, choice).click());
    await view.render();
    assert.deepEqual(sent, [choice], "the original model input is preserved");
    assert.equal(view.container.querySelector('.vn-text.vn-action')?.textContent, "Flash a confident grin and place 100 gold coins on the counter.");
    assert.equal(view.container.querySelector('.vn-name')?.textContent?.trim(), "");
    assert.ok(view.container.querySelector('.vn-sprite[src="persona-happy.png"]'));
    await act(async () => findButton(view.container, "Skip").click());
    assert.equal(view.container.querySelector('.vn-text')?.textContent, "Is this enough for now?");
    assert.equal(view.container.querySelector('.vn-text.vn-action'), null);
    assert.match(view.container.querySelector('.vn-name')?.textContent ?? "", /Aelorian Myrren/);
    await act(async () => view.container.querySelector('.vn')!.dispatchEvent(new view.dom.window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })));
    assert.ok(view.container.querySelector('.vn-text.vn-action'));
    await advance();
    fixture.api.isStreaming = false;
    fixture.api.messages.push({ id: "new-answer", role: "assistant", content: '[SPEAKER:Miveth:normal] "Yes, that is enough."' });
    await view.render();
    assert.equal(view.container.querySelector('.vn-text')?.textContent, "Is this enough for now?");
    await advance();
    assert.equal(view.container.querySelector('.vn-text')?.textContent, "Yes, that is enough.");
  } finally {
    await act(async () => view.root.unmount()); view.dom.window.close(); view.restore();
  }
});

test("VN greeting never offers pending-response recovery", async () => {
  const fixture = makeApi();
  fixture.api.messages = [];
  fixture.api.greetingContent = '[SPEAKER:Miveth:normal] "Welcome."';
  const view = await setup(fixture.api);
  try {
    await view.render();
    assert.equal(view.container.querySelector('.vn-retry-response'), null);
    assert.equal(view.container.querySelector('.vn-change-choice'), null);
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("VN recovery supports the older SDK and keeps changing a choice available after an error", async () => {
  const fixture = makeApi();
  delete fixture.api.retryPendingReply;
  let retries = 0;
  fixture.api.continueLastMessage = async () => { retries++; throw new Error("The reply could not be generated."); };
  const view = await setup(fixture.api);
  try {
    await view.render();
    await act(async () => findButton(view.container, "Retry response").click());
    assert.equal(retries, 1);
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /reply could not be generated/);
    await act(async () => findButton(view.container, "Choose something else").click());
    await view.render();
    assert.deepEqual(fixture.api.deleteCalls, ["user-pending"]);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.container.querySelectorAll('.vn-choice').length, 5);
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("VN log separates recovered choice metadata and mixed state wrappers from actual speech", async () => {
  const fixture = makeApi();
  const content = '[SPEAKER:NPC:normal] "Enrolled."\n[CHOCIES: ["Step forward", "Help the boy"]]\n[game-state]\nacademy-day: 1\nplayer-wealth: 90\n</game-state>\n*The clerk returns to his desk.*';
  fixture.api.messages = [{ ...fixture.oldAssistant, content, swipes: [{ content }]}];
  const view = await setup(fixture.api);
  try {
    await view.render();
    await act(async () => findButton(view.container, "Log").click());
    const log = view.container.querySelector('.vn-log')!;
    assert.ok(log);
    assert.match(log.textContent ?? "", /Enrolled\./);
    assert.match(log.textContent ?? "", /The clerk returns to his desk\./);
    assert.doesNotMatch(log.textContent ?? "", /CHOCIES|Step forward|Help the boy|game-state|academy-day|player-wealth/i);
    assert.equal(log.querySelectorAll('.vn-log-row').length, 1, "only the spoken line gets an NPC row");
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("VN recovers choices with invisible padding as controls and excludes them from the log", async () => {
  for (const padding of ["\u200B", "\u2060"]) {
    const fixture = makeApi();
    const choices = ["Hold steady", "Ask about the experiment", "Step back"];
    const content = `[SPEAKER:Miveth:normal] "Keep it steady."\n*The lesson continues.*\n[${padding}CHOICES: ${JSON.stringify(choices)}]`;
    fixture.api.messages = [{ ...fixture.oldAssistant, content, swipes: [{ content, rawContent: content }] }];
    const view = await setup(fixture.api);
    try {
      await view.render();
      await act(async () => findButton(view.container, "Log").click());
      const log = view.container.querySelector('.vn-log-scroll')!;
      assert.match(log.textContent ?? "", /Keep it steady|The lesson continues/);
      assert.doesNotMatch(log.textContent ?? "", /CHOICES|Hold steady|Ask about the experiment|Step back/);
      await act(async () => findButton(view.container, "Close log").click());
      await act(async () => findButton(view.container, "Advance story").click());
      assert.deepEqual(Array.from(view.container.querySelectorAll(".vn-choice:not(.vn-custom-choice)")).map(node => node.textContent?.trim()), choices);
    } finally {
      await act(async () => view.root.unmount());
      view.dom.window.close();
      view.restore();
    }
  }
});
