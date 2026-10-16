import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const folder = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(folder).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(new URL(name, folder), "utf8")]));

test("character bars unlock on marked stage entrances or dialogue, not mentions, and retain their custom design and values", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!, root = createRoot(container);
  const storage = new Map<string, string>();
  const content = '*Someone mentions Diane and Ryu in a rumor.*\n\n[SPEAKER:Diane:normal] *Diane steps through the doorway.*\n\n[SPEAKER:Narrator:normal] *Diane mentions Ryu by name.*\n\n[SPEAKER:Ryu:smug] "I am here."';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mutable SDK fixture.
  const api: any = {
    sessionId: "visibility-test", worldId: "world", worldName: "Academy", entries: [{ id: "diane", name: "Diane Bluerose", role: "character" }, { id: "ryu", name: "Ryu (Ryutharax)", role: "character" }],
    variables: { "rel-diane": 25, "rel-ryu": -8, "player-reputation": 80 }, messages: [{ id: "reply", role: "assistant", content }], pendingChoices: [], isStreaming: false,
    storage: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, value: string) => { storage.set(key, value); } },
    renderMarkdown: (text: string) => text, resolveAssetUrl: (ref: string) => ref,
  };
  const customLayout = `export default function StatusLayout({config,variables}) { return <div data-custom-layout="retained">{config.fields.map(field => <div key={field.id} data-character-bar={field.variableId} style={{color:field.color}}>{field.label}: {variables[field.variableId]}</div>)}</div>; }`;
  const config = { title: "Status", groups: [{ id: "relationships", label: "Relationships" }], fields: [
    { id: "diane-bar", label: "Diane affinity", variableId: "rel-diane", characterId: "diane", color: "#aabbcc" },
    { id: "ryu-bar", label: "Ryu affinity", variableId: "rel-ryu", color: "#ccbbaa" },
    { id: "reputation", label: "Reputation", variableId: "player-reputation", color: "#ffffff" },
  ] };
  const result = bundleAndCompile({ files: { ...files, "status-config.ts": `export const statusConfig = ${JSON.stringify(config)};`, "status-layout.tsx": customLayout }, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const render = async () => act(async () => root.render(createElement(result.Component!)));
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(node => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  const status = async () => { await click("Menu"); await click("Status"); assert.ok(container.querySelector('[data-custom-layout="retained"]')); };
  const visible = () => [...container.querySelectorAll('[data-character-bar]')].map(node => node.getAttribute('data-character-bar'));
  try {
    await render(); await status();
    assert.deepEqual(visible(), ["player-reputation"], "Names in narration do not unlock character bars");
    await click("Close status"); await click("Advance story"); await status();
    assert.deepEqual(visible(), ["rel-diane", "player-reputation"]);
    const bar = container.querySelector<HTMLElement>('[data-character-bar="rel-diane"]')!;
    assert.match(bar.textContent!, /25/); assert.equal(bar.style.color, "rgb(170, 187, 204)");
    await click("Close status"); await click("Advance story"); await status();
    assert.deepEqual(visible(), ["rel-diane", "player-reputation"], "Mentioning Ryu does not reveal Ryu");
    await click("Close status"); await click("Advance story"); await status();
    assert.deepEqual(visible(), ["rel-diane", "rel-ryu", "player-reputation"]);
    assert.match(container.querySelector('[data-character-bar="rel-ryu"]')!.textContent!, /-8/);
    await click("Close status");
    await act(async () => container.querySelector(".vn-stage")!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })));
    await status();
    assert.deepEqual(visible(), ["rel-diane", "rel-ryu", "player-reputation"], "Reading backwards does not forget an encounter");
    api.messages = [{ id: 'reply', role: 'assistant', activeSwipeIndex: 1, content: '*A different branch only mentions Diane and Ryu.*' }];
    await render();
    assert.deepEqual(visible(), ["player-reputation"], "A replacement swipe does not inherit discarded encounters");
    api.sessionId = 'another-session';
    api.messages = [{ id: 'another-reply', role: 'assistant', content: '*Ryu is only mentioned here.*' }];
    api.hasEarlierMessages = true;
    const checked: string[] = [];
    api.getCharacterEncounters = async (id: string) => { checked.push(id); return ['diane']; };
    await render();
    assert.deepEqual(visible(), ["rel-diane", "player-reputation"], "Earlier paginated encounters are backfilled without exposing unintroduced characters");
    assert.deepEqual(checked, ['another-reply']);
    assert.deepEqual(api.variables, { "rel-diane": 25, "rel-ryu": -8, "player-reputation": 80 });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
