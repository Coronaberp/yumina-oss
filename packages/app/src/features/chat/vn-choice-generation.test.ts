import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

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

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  assert.ok(found, `Missing button ${text}`);
  return found;
}

interface FixtureApi extends Record<string, unknown> {
  messages: { id: string; role: string; content: string; activeSwipeIndex?: number; swipes?: { content: string; choices?: string[]; reasoningContent?: string }[] }[];
  pendingChoices: string[];
  hasEarlierMessages: boolean;
  loadEarlierMessages?: () => Promise<void>;
}

function fixture(overrides: Record<string, unknown> = {}) {
  let resolveChoices!: (choices: string[]) => void;
  let rejectChoices!: (error: Error) => void;
  let calls = 0;
  const message = { id: "m1", role: "assistant", content: "*Opening.*\n\n*The scene ends.*", swipes: [{ content: "*Opening.*\n\n*The scene ends.*", choices: [] as string[] }], activeSwipeIndex: 0 };
  const api: FixtureApi = {
    sessionId: "choice-test", worldId: "world", worldName: "Academy", variables: {}, entries: [],
    messages: [message], pendingChoices: [], isStreaming: false, streamingContent: "", greetingContent: null,
    hasEarlierMessages: false, readOnly: false, error: null,
    storage: { get: async () => null, set: async () => {} },
    renderMarkdown: (s: string) => s, resolveAssetUrl: (s: string) => s,
    sendMessage: () => { throw new Error("generate choices must not send player input"); },
    continueLastMessage: () => { throw new Error("generate choices must not continue the story"); },
    generateChoices: () => {
      calls++;
      return new Promise<string[]>((resolve, reject) => { resolveChoices = resolve; rejectChoices = reject; });
    },
    ...overrides,
  };
  return {
    api,
    message,
    getCalls: () => calls,
    resolve: (choices: string[]) => {
      message.swipes[0].choices = choices;
      api.pendingChoices = choices;
      resolveChoices(choices);
    },
    reject: (error: Error) => rejectChoices(error),
  };
}

async function renderFixture(api: unknown) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore = installDom(dom);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  return { dom, restore, root, container, render };
}

test("VN choices render italic actions and quoted dialogue while sending their original text", async () => {
  const choices = ['*Inspect the cup*', '"Can you explain?"', '*Raise your hand * "I will try."', '<img src=x onerror="alert(1)">', '*Resume the duel "I will hold back."'];
  const sent: string[] = [];
  const state = fixture({ sendMessage: (text: string) => { sent.push(text); } });
  state.message.swipes[0].choices = choices;
  const view = await renderFixture(state.api);
  try {
    await view.render();
    await act(async () => button(view.container, "Skip").click());
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('.vn-choice:not(.vn-custom-choice)')];
    assert.equal(buttons.length, choices.length);
    assert.equal(buttons[0].querySelector('em')?.textContent, "Inspect the cup");
    assert.equal(buttons[0].textContent?.trim(), "Inspect the cup");
    assert.equal(buttons[0].getAttribute('aria-label'), "Inspect the cup");
    assert.equal(buttons[4].getAttribute('aria-label'), 'Resume the duel "I will hold back."');
    assert.equal(buttons[4].querySelector('em')?.textContent, 'Resume the duel ');
    assert.equal(buttons[4].querySelector('.vn-choice-dialogue')?.textContent, '"I will hold back."');
    assert.equal(buttons[1].querySelector('.vn-choice-dialogue')?.textContent, '"Can you explain?"');
    assert.equal(buttons[2].querySelector('em')?.textContent, "Raise your hand ");
    assert.equal(buttons[2].querySelector('.vn-choice-dialogue')?.textContent, '"I will try."');
    assert.equal(buttons[3].querySelector('img'), null, "choice markup cannot create HTML elements");
    await act(async () => buttons[2].click());
    await act(async () => buttons[2].click());
    assert.deepEqual(sent, [choices[2]], "formatting stays in the selected player input and duplicate clicks stay blocked");
  } finally {
    await act(async () => view.root.unmount());
    view.dom.window.close();
    view.restore();
  }
});

test("VN exposes manual Generate choices only on the final page and never calls it automatically", async () => {
  const fixtureState = fixture();
  const { api, getCalls } = fixtureState;
  const { dom, restore, root, container, render } = await renderFixture(api);
  try {
    await render();
    assert.equal(getCalls(), 0);
    assert.equal(container.querySelector('.vn-generate-choices'), null, "first page has no generation control");
    await act(async () => button(container, "Advance story").click());
    assert.ok(container.querySelector('[aria-label="Generate choices"]') || container.textContent?.includes("Generate choices"));
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice):not(.vn-generate-choices)").length, 0);
    assert.equal(container.querySelectorAll(".vn-custom-choice").length, 1);
    const generate = container.querySelector<HTMLButtonElement>('[aria-label="Generate choices"]') ?? button(container, "Generate choices");
    assert.ok(generate.classList.contains("vn-choice"), "the utility uses choice styling");
    assert.deepEqual(Array.from(container.querySelectorAll('.vn-choices button')).map(b => b.textContent?.trim()), ["Generate choices", "..."]);
    const before = container.querySelector('.vn-dialogue')!.textContent;
    await act(async () => { generate.click(); generate.click(); });
    assert.equal(getCalls(), 1, "concurrent clicks are coalesced");
    assert.equal(generate.disabled, true);
    assert.equal(generate.getAttribute("aria-busy"), "true");
    assert.ok(container.querySelector('.vn-choice-spinner'));
    assert.equal(container.querySelector('.vn-dialogue')!.textContent, before);
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice):not(.vn-generate-choices)").length, 0, "no choices appear before completion");
    await act(async () => { fixtureState.resolve(["Stay", "Leave"]); await Promise.resolve(); });
    await render();
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice)").length, 2);
    assert.equal(container.querySelector('.vn-generate-choices'), null);
    assert.deepEqual(Array.from(container.querySelectorAll('.vn-choices button')).map(b => b.textContent?.trim()), ["Stay", "Leave", "..."]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
  }
});

test("VN generation keeps the final page stable on explicit failure and permits retry", async () => {
  const fixtureState = fixture();
  const { dom, restore, root, container, render } = await renderFixture(fixtureState.api);
  try {
    await render();
    await act(async () => button(container, "Advance story").click());
    const before = container.querySelector('.vn-dialogue')!.textContent;
    const generate = () => container.querySelector<HTMLButtonElement>('[aria-label="Generate choices"]') ?? button(container, "Generate choices");
    await act(async () => generate().click());
    assert.equal(fixtureState.getCalls(), 1);
    await act(async () => { fixtureState.reject(new Error("choice provider failed")); await Promise.resolve(); });
    assert.equal(container.querySelectorAll(".vn-choice:not(.vn-custom-choice):not(.vn-generate-choices)").length, 0);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /choice provider failed/);
    assert.equal(container.querySelector('.vn-dialogue')!.textContent, before);
    assert.ok(generate(), "failed generation can be retried");
    await act(async () => generate().click());
    assert.equal(fixtureState.getCalls(), 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
  }
});

test("Log opens at the beginning of the viewed turn and keeps earlier history above it", async () => {
  for (const currentTurnId of ["m1", "older"]) {
    const state = fixture({ storage: {
      get: async (key: string) => key.endsWith(":cursor") ? JSON.stringify({ turn: `${currentTurnId}:0`, index: 1 }) : null,
      set: async () => {},
    } });
    const older = { ...state.message, id: "older", content: "*Earlier beginning.*\n\n*Earlier ending.*" };
    state.api.messages = [older, state.message];
    state.message.swipes[0] = { ...state.message.swipes[0], reasoningContent: "Saved thinking" } as typeof state.message.swipes[0];
    const { dom, restore, root, container, render } = await renderFixture(state.api);
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const top = this.dataset.turnId === "m1" ? 900 : this.dataset.turnId === "older" ? 400 : 100;
      return { top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0, toJSON: () => ({ top }) };
    };
    try {
      await render();
      const passage = container.querySelector(".vn-dialogue")!.textContent;
      await act(async () => button(container, "Log").click());
      const scroll = container.querySelector<HTMLElement>(".vn-log-scroll")!;
      assert.equal(scroll.scrollTop, currentTurnId === "m1" ? 800 : 300);
      assert.equal(scroll.querySelectorAll("[data-turn-id]").length, 2, "all previous turns stay in the log");
      const current = scroll.querySelector('[data-turn-id="m1"]')!;
      assert.ok(current.nextElementSibling?.classList.contains("vn-thinking"), "the turn begins before its Thinking disclosure");
      await act(async () => button(container, "Close log").click());
      assert.equal(container.querySelector(".vn-dialogue")!.textContent, passage, "opening Log leaves the reading page unchanged");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      restore();
    }
  }
});

test("Log combines multiple character chips with stable turn selection and resets the complete history", async () => {
  const state = fixture({
    entries: [
      { name: "Alice", role: "character", portrait: "asset:alice" },
      { name: "Bob", role: "character", portrait: "asset:bob" },
    ],
    user: { name: "Player" },
  });
  const reply = (id: string, content: string) => ({ id, role: "assistant", content, activeSwipeIndex: 0, swipes: [{ content, reasoningContent: "Private thinking" }] });
  state.api.messages = [
    { id: "system", role: "system", content: "Never displayed" },
    reply("opening", '*The gates open.*\n[SPEAKER:Alice:normal] "Welcome."'),
    { id: "choice", role: "user", content: "Enter the academy" },
    reply("m1", '*The class begins.*\n[SPEAKER:Bob:normal] "Take a seat."\n[SPEAKER:Alice:normal] "Let us begin."'),
  ];
  const { dom, restore, root, container, render } = await renderFixture(state.api);
  const changeTurn = async (value: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(`.vn-turn-option[data-value="${value}"]`)!.click());
  };
  const logText = () => container.querySelector(".vn-log-scroll")!.textContent!;
  try {
    await render();
    const reading = container.querySelector(".vn-dialogue")!.textContent;
    await act(async () => button(container, "Log").click());
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    assert.deepEqual(Array.from(container.querySelectorAll(".vn-turn-option > span:first-child")).map(option => option.textContent), ["All turns", "Turn 1", "Turn 2 (current)"]);
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    const chips = container.querySelector<HTMLElement>(".vn-log-character-filters")!;
    assert.equal(chips.querySelectorAll(".vn-avatar").length, 3, "characters and the player have portrait chips");
    await act(async () => button(chips, "Alice").click());
    assert.equal(button(chips, "Alice").getAttribute("aria-pressed"), "true");
    assert.match(logText(), /Welcome/);
    assert.match(logText(), /Let us begin/);
    assert.doesNotMatch(logText(), /Take a seat|The gates open|Enter the academy|Private thinking|Never displayed/);
    await act(async () => button(chips, "Bob").click());
    assert.match(logText(), /Take a seat/);
    await changeTurn("m1");
    assert.doesNotMatch(logText(), /Welcome/);
    assert.match(logText(), /Let us begin|Take a seat/);
    await act(async () => button(chips, "Alice").click());
    await changeTurn("opening");
    assert.match(logText(), /No dialogue matches these filters/);
    await act(async () => button(container, "Reset filters").click());
    assert.equal(button(chips, "All characters").getAttribute("aria-pressed"), "true");
    assert.match(logText(), /Welcome/);
    assert.match(logText(), /The gates open/);
    assert.match(logText(), /Enter the academy/);
    await changeTurn("m1");
    await act(async () => button(chips, "Player (You)").click());
    assert.match(logText(), /Enter the academy/);
    assert.doesNotMatch(logText(), /Let us begin|Take a seat|The class begins/);
    await act(async () => button(chips, "All characters").click());
    await act(async () => button(chips, "Narration").click());
    assert.match(logText(), /The class begins/);
    assert.doesNotMatch(logText(), /Enter the academy|Take a seat|Let us begin/);
    await act(async () => button(container, "Close log").click());
    assert.equal(container.querySelector(".vn-dialogue")!.textContent, reading);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); restore();
  }
});

test("Log turn filters retain message IDs when earlier history is loaded and include pending choices", async () => {
  const state = fixture({ hasEarlierMessages: true });
  state.api.messages = [{ ...state.message, id: "recent" }, { id: "pending-choice", role: "user", content: "Unanswered choice" }];
  state.api.loadEarlierMessages = async () => {
    state.api.messages = [{ ...state.message, id: "earlier" }, ...state.api.messages];
    state.api.hasEarlierMessages = false;
  };
  const { dom, restore, root, container, render } = await renderFixture(state.api);
  const selectTurn = async (value: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(`.vn-turn-option[data-value="${value}"]`)!.click());
  };
  try {
    await render();
    await act(async () => button(container, "Log").click());
    await selectTurn("recent");
    assert.doesNotMatch(container.querySelector(".vn-log-scroll")!.textContent!, /Unanswered choice/);
    await act(async () => button(container, "Load earlier dialogue").click());
    await render();
    assert.match(container.querySelector('.vn-turn-trigger')!.textContent!, /Turn 2 \(current\)/);
    assert.equal(container.querySelectorAll(".vn-log-scroll [data-turn-id]").length, 1);
    await selectTurn("pending");
    assert.match(container.querySelector(".vn-log-scroll")!.textContent!, /Unanswered choice/);
    assert.equal(container.querySelectorAll(".vn-log-scroll [data-turn-id]").length, 0);
    state.api.messages = [...state.api.messages, { ...state.message, id: "completed" }];
    await render();
    assert.match(container.querySelector('.vn-turn-trigger')!.textContent!, /All turns/, "a completed pending reply returns to all turns");
  } finally {
    await act(async () => root.unmount()); dom.window.close(); restore();
  }
});

test("Log filters include a preview greeting and unknown NPC dialogue", async () => {
  const state = fixture({ messages: [], greetingContent: '*Preview opening.*\n[SPEAKER:Unknown:normal] "Hello there."' });
  const { dom, restore, root, container, render } = await renderFixture(state.api);
  try {
    await render();
    await act(async () => button(container, "Log").click());
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    assert.equal(container.querySelector('.vn-turn-option[data-value="greeting"] > span')!.textContent, "Turn 1 (current)");
    await act(async () => container.querySelector<HTMLButtonElement>('.vn-turn-trigger')!.click());
    await act(async () => button(container.querySelector(".vn-log-character-filters")!, "NPC").click());
    assert.match(container.querySelector(".vn-log-scroll")!.textContent!, /Hello there/);
    assert.doesNotMatch(container.querySelector(".vn-log-scroll")!.textContent!, /Preview opening/);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); restore();
  }
});
