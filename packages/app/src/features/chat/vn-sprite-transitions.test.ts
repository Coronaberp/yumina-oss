import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));
type Sprite = { name: string; emotion: string; src: string; key?: string };

async function stage(run: (harness: {
  container: HTMLElement;
  show: (cast: Sprite[], speaker?: string) => Promise<void>;
  load: (image: HTMLImageElement) => Promise<void>;
  finish: (slot: HTMLElement) => Promise<void>;
}) => Promise<void>, reducedMotion = false) {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: reducedMotion }) });
  Object.defineProperty(dom.window, "AnimationEvent", { value: dom.window.Event });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const api = { cast: [] as Sprite[], speaker: "" };
  const probe = 'import { useSpritePresence, SpriteSlot } from "./sprite-stage"; export default function Probe(){ const api=useYumina(); const [cast,finish]=useSpritePresence(api.cast); return <div className="vn-cast">{cast.map(character => <SpriteSlot key={character.key || character.name.toLowerCase()} character={character} speaker={api.speaker} onExit={finish} />)}</div>; }';
  const result = bundleAndCompile({ files: { ...files, "probe.tsx": probe }, entryFile: "probe.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  try {
    await run({
      container,
      show: async (cast, speaker = "") => { api.cast = cast; api.speaker = speaker; await act(async () => root.render(createElement(result.Component!))); },
      load: async image => { await act(async () => image.dispatchEvent(new dom.window.Event("load"))); },
      finish: async slot => {
        const event = new dom.window.Event("animationend", { bubbles: true });
        Object.defineProperty(event, "animationName", { value: "vn-sprite-out" });
        await act(async () => slot.dispatchEvent(event));
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const sprite = (name: string, emotion = "normal"): Sprite => ({ name, emotion, src: `/${name}-${emotion}.png` });

test("sprites wait for image load, keep expression updates, and retain exits until the fade ends", async () => {
  await stage(async ({ container, show, load, finish }) => {
    const image = (name: string) => container.querySelector<HTMLImageElement>(`[data-character="${name}"]`)!;
    await show([sprite("A"), sprite("B")], "b");
    const original = image("A"), departing = image("B").parentElement!;
    assert.equal(original.parentElement!.dataset.ready, "false");
    await load(original);
    await load(image("B"));
    await show([sprite("A", "happy"), sprite("C")], "c");
    assert.ok(image("A") === original, "an expression update reuses the loaded sprite");
    assert.equal(original.parentElement!.dataset.ready, "true");
    assert.equal(original.getAttribute("src"), "/A-happy.png");
    assert.equal(departing.dataset.exiting, "true");
    assert.equal(departing.style.position, "absolute", "departures do not consume another cast slot");
    assert.equal(departing.style.left, "50%", "the outgoing sprite keeps its old position");
    assert.equal(departing.style.width, "50%");
    assert.equal(departing.getAttribute("aria-hidden"), "true");
    assert.equal(image("B").dataset.active, "false");
    assert.equal(image("C").dataset.active, "true");
    assert.equal(container.querySelectorAll('.vn-sprite-slot[data-exiting="false"]').length, 2);
    await finish(departing);
    assert.ok(!image("B"), "an exit is removed only after its fade completes");
  });
});

test("a returning speaker cancels retirement and rapid updates keep identities unique", async () => {
  await stage(async ({ container, show }) => {
    await show([sprite("A"), sprite("B")]);
    const original = container.querySelector('[data-character="A"]');
    await show([sprite("B"), sprite("C")]);
    await show([sprite("A", "happy"), sprite("C")]);
    assert.ok(container.querySelector('[data-character="A"]') === original);
    assert.equal(original!.parentElement!.dataset.exiting, "false");
    assert.equal(container.querySelectorAll('[data-character="A"]').length, 1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    assert.ok(container.querySelector('[data-character="A"]') === original, "the cancelled exit timer cannot remove a returned speaker");
    assert.ok(!container.querySelector('[data-character="B"]'), "the fallback cleans up an interrupted animation");
    await show([]);
    assert.equal(container.querySelectorAll('[data-exiting="true"]').length, 2, "scene resets fade out the preceding cast");
  });
});

test("distinct NPC identities fade independently despite sharing their display name", async () => {
  await stage(async ({ container, show, finish }) => {
    const clerk = { ...sprite("NPC"), key: "npc:male:clerk" };
    const guard = { ...sprite("NPC"), key: "npc:male:guard" };
    await show([clerk, guard], guard.key);
    await show([guard, sprite("A")], "a");
    const departing = container.querySelector<HTMLElement>('[data-npc-id="npc:male:clerk"]')!.parentElement!;
    assert.equal(departing.dataset.exiting, "true");
    assert.equal(container.querySelector('[data-npc-id="npc:male:guard"]')!.parentElement!.dataset.exiting, "false");
    await finish(departing);
    assert.ok(!container.querySelector('[data-npc-id="npc:male:clerk"]'));
    assert.ok(container.querySelector('[data-npc-id="npc:male:guard"]'));
  });
});

test("reduced motion replaces the cast immediately without retaining fading sprites", async () => {
  await stage(async ({ container, show }) => {
    await show([sprite("A"), sprite("B")]);
    await show([sprite("B"), sprite("C")]);
    assert.ok(!container.querySelector('[data-character="A"]'));
    assert.equal(container.querySelectorAll('[data-exiting="true"]').length, 0);
    await show([]);
    assert.equal(container.querySelectorAll(".vn-sprite").length, 0);
  }, true);
});
