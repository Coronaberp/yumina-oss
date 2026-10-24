import assert from "node:assert/strict";
import test, { after } from "node:test";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { makeChatT } from "../../../sandbox/chat/i18n";

const testDoms: JSDOM[] = [];
after(() => testDoms.forEach(dom => dom.window.close()));
const t = makeChatT("en");
function messages(count: number, first = 0) { return Array.from({ length: count }, (_, n) => ({ id: `m${n + first}`, sessionId: "fixture", role: "assistant" as const,
  content: `[speaker: C${n % 2}] Message ${n + first}.`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n + first)).toISOString() })); }

async function setup(count = 1000, entries: Array<Record<string, unknown>> = [], nested = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://sandbox.test/?parentOrigin=https%3A%2F%2Fapp.test", pretendToBeVisual: true });
  testDoms.push(dom);
  const keys = ["window", "document", "navigator", "Element", "HTMLElement", "Node", "MutationObserver", "CustomEvent", "CSS", "Image", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let serial = 0, extraHeight = 0; const frames = new Map<number, FrameRequestCallback>(), requested: string[] = [];
  const resizeCallbacks = new Set<() => void>();
  dom.window.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const css = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  class Observer { constructor(_callback: unknown) {} observe() {} unobserve() {} disconnect() {} }
  class ResizeFixture { constructor(public callback: () => void) { resizeCallbacks.add(callback); } observe() {} disconnect() { resizeCallbacks.delete(this.callback); } }
  class ImageFixture { decoding = ""; set src(value: string) { requested.push(value); } }
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, CSS: css, Image: ImageFixture, ResizeObserver: ResizeFixture, IntersectionObserver: Observer,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), React, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get() { return this.querySelectorAll(".play-message-row").length * 40 + 100 + extraHeight; } },
    clientHeight: { configurable: true, get() { return nested && this.classList.contains("play-message-scroll") ? this.scrollHeight : 200; } },
    offsetHeight: { configurable: true, get() { return this.clientHeight; } },
    scrollTo: { configurable: true, value(options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } },
  });
  proto.getBoundingClientRect = function() {
    if (this.matches("[data-mid]")) {
      const stack = this.parentElement!, rows = [...stack.querySelectorAll("[data-mid]")], viewport = (nested ? this.closest(".nested-scroll") : this.closest(".play-message-scroll")) as HTMLElement;
      const top = rows.indexOf(this) * 40 - (viewport?.scrollTop ?? 0);
      return { top, bottom: top + 40, height: 40, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} };
    }
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON() {} };
  };
  const [{ createRoot }, { MessageList }, { YuminaContext, buildAPI }] = await Promise.all([import("react-dom/client"), import("../../../sandbox/chat/message-list"), import("../../../sandbox/sandbox-context")]);
  const container = document.getElementById("root")!, root = createRoot(container), calls: string[] = [];
  const base = buildAPI({ variables: {}, globalVariables: {}, worldName: "History fixture", worldCover: null, worldId: "world", sessionId: "fixture", currentUser: null,
    user: { name: "Player", avatar: null }, messages: messages(count), entries, isStreaming: false, streamingContent: "", mode: "session" } as unknown as Parameters<typeof buildAPI>[0]);
  let api = { ...base, hasEarlierMessages: false, isLoadingEarlier: false, loadEarlierMessages: async () => { calls.push("load"); return false; }, editMessage: async (id: string, content: string) => { calls.push(`edit:${id}:${content}`); return true; } };
  const render = async (updates: Record<string, unknown> = {}) => {
    api = { ...api, ...updates };
    await act(async () => root.render(createElement(YuminaContext.Provider, { value: api }, nested ? createElement("div", { className: "nested-scroll", style: { overflowY: "auto" } }, createElement(MessageList, { rendererComponent: null })) : createElement(MessageList, { rendererComponent: null }))));
    const list = container.querySelector<HTMLElement>(".play-message-scroll"); if (list) list.style.overflowY = "auto";
  };
  const rows = () => [...container.querySelectorAll<HTMLElement>("[data-mid]")];
  const viewport = () => container.querySelector<HTMLElement>(nested ? ".nested-scroll" : ".play-message-scroll")!;
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === name);
  const older = async () => { viewport().scrollTop = 0; const b = button(t("loadEarlier")); assert.ok(b, "Older history is reachable"); await act(async () => b.click()); };
  const newer = async () => { const b = container.querySelector<HTMLButtonElement>('[data-history-direction="newer"]'); assert.ok(b, "Newer history remains reachable"); await act(async () => b.click()); };
  const jump = async (edge: "oldest" | "newest", keyboard = false) => {
    const b = container.querySelector<HTMLButtonElement>(`[data-history-jump="${edge}"]`); assert.ok(b,"A direct loaded-history jump is reachable");
    b.focus();
    await act(async () => { if (keyboard) b.dispatchEvent(new dom.window.KeyboardEvent("keydown",{bubbles:true,key:"Enter"})); b.click(); });
    return b;
  };
  const flush = async () => { await act(async () => { for (let i = 0; frames.size && i < 8; i++) { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(0)); } }); };
  const grow = async (pixels: number) => { extraHeight += pixels; await act(async()=>resizeCallbacks.forEach(callback=>callback())); await flush(); };
  await render();
  return { dom, container, requested, calls, rows, viewport, render, older, newer, jump, flush, grow, api: () => api,
    close: async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test("a 1000-character roster warms only the two mounted speaker portraits", async ctx => {
  const entries = Array.from({ length: 1000 }, (_, n) => ({ id: `c${n}`, name: `C${n}`, role: "character", enabled: true, portrait: `https://app.test/cdn/${String(n).padStart(8, "0")}-2222-4333-8444-555555555555` }));
  const view = await setup(6, entries);
  try {
    assert.equal(new Set(view.requested).size, 2, "Unused roster portraits never create warm Images");
    ctx.diagnostic(JSON.stringify({ rosterEntries: entries.length, usedFaces: 2, uniqueWarmRequests: new Set(view.requested).size, measurement: "synthetic Image constructor requests, not network or device memory" }));
    assert.ok(view.requested.every(url => url.includes("variant=portrait")), "Only display-sized variants are warmed");
    assert.ok(view.container.querySelectorAll('img[src*="variant=portrait"]').length > 0);
    const image = view.container.querySelector<HTMLImageElement>(".play-message-speaker img")!;
    const original = image.src.replace("?variant=portrait", "");
    await act(async () => image.dispatchEvent(new view.dom.window.Event("error")));
    assert.equal(image.src, original, "A failed variant falls back to its exact original");
    await act(async () => image.dispatchEvent(new view.dom.window.Event("error")));
    assert.equal(image.src, original, "Original failure cannot loop");
  } finally { await view.close(); }
});

test("direct loaded-history jumps reach both ends once, keep paging bounded, and follow only explicit newest intent", async () => {
  const view = await setup(1000,[],true);
  try {
    const original = view.api().messages, ids = original.map(row=>row.id);
    await view.render({hasEarlierMessages:true});
    const control = await view.jump("oldest",true); await view.flush();
    assert.equal(view.rows()[0]?.dataset.mid,"m0"); assert.equal(view.rows().at(-1)?.dataset.mid,"m99");
    assert.equal(view.viewport().scrollTop,0); assert.equal(view.dom.window.document.activeElement,control,"No message or composer steals keyboard focus");
    assert.deepEqual(view.calls,[],"Oldest loaded does not fetch the rest of server history");
    await view.newer(); assert.equal(view.rows()[0]?.dataset.mid,"m50");
    await view.older(); assert.equal(view.rows()[0]?.dataset.mid,"m0");
    assert.deepEqual(view.calls,["load"],"normal Older retains its existing bounded server-page behavior");
    await view.jump("newest",true); await view.flush();
    assert.equal(view.rows().at(-1)?.dataset.mid,"m999"); assert.ok(view.rows().length<=100);
    assert.equal(view.viewport().scrollTop,view.viewport().scrollHeight-view.viewport().clientHeight);
    await view.render({messages:[...original,...messages(100,1000)],isStreaming:true,streamingContent:"Live newest reply"});
    assert.equal(view.rows().at(-1)?.dataset.mid,"m1099"); assert.ok(view.container.textContent?.includes("Live newest reply"));
    await view.jump("oldest");
    await view.render({messages:[...view.api().messages,...messages(5,1100)],streamingContent:"Later live reply"});
    assert.equal(view.rows()[0]?.dataset.mid,"m0"); assert.equal(view.rows().at(-1)?.dataset.mid,"m99");
    assert.ok(!view.container.textContent?.includes("Later live reply"));
    assert.deepEqual(original.map(row=>row.id),ids); assert.equal(original.length,1000); assert.deepEqual(view.calls,["load"],"jumps never add server requests");
  } finally { await view.close(); }
});

test("loaded jumps are honest for partial/empty history and cannot unmount an edit or saving draft", async () => {
  const empty = await setup(0);
  try { assert.equal(empty.container.querySelector('[data-history-jump]'),null); } finally { await empty.close(); }
  const view = await setup(20);
  try {
    await view.render({hasEarlierMessages:true});
    const oldest = await view.jump("oldest"); await view.flush();
    assert.match(oldest.textContent!,/loaded/i); assert.equal(view.rows().length,20); assert.deepEqual(view.calls,[]);
    const row = view.rows()[0]!;
    await act(async()=>row.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
    assert.ok(view.container.querySelector<HTMLButtonElement>('[data-history-jump="newest"]')!.disabled);
    await view.jump("newest"); assert.equal(view.rows()[0],row); assert.ok(row.querySelector("textarea"));
    let finish: (value:boolean)=>void = ()=>{}, saveStarted = false;
    await view.render({editMessage:()=>new Promise<boolean>(resolve=>{saveStarted=true;finish=resolve;})});
    await act(async()=>row.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(new view.dom.window.KeyboardEvent("keydown",{bubbles:true,key:"Enter",ctrlKey:true})));
    assert.equal(saveStarted,true); assert.ok(row.querySelector<HTMLTextAreaElement>("textarea")!.disabled);
    assert.ok(view.container.querySelector<HTMLButtonElement>('[data-history-jump="oldest"]')!.disabled);
    await act(async()=>finish(true));
    await view.render({isLoadingEarlier:true});
    assert.ok(view.container.querySelector<HTMLButtonElement>('[data-history-jump="newest"]')!.disabled);
    await view.render({isLoadingEarlier:false});
    await view.render({messages:messages(5)}); await view.jump("newest"); assert.equal(view.rows().at(-1)?.dataset.mid,"m4");
    await view.render({sessionId:"different",messages:messages(1000)}); assert.equal(view.rows().length,50);
  } finally { await view.close(); }
});

test("keyboard loaded-history jumps cancel resume and cannot be overwritten by a late checkpoint", async () => {
  const view = await setup();
  try {
    const {restoreTranscriptPosition} = await import("../../../sandbox/chat/transcript-position");
    const position = {version:1 as const,sessionId:"fixture",mode:"reading" as const,anchorId:"m100",offset:-20,top:4000,expanded:true,loadedCount:1000};
    await act(async()=>restoreTranscriptPosition(position)); await view.flush();
    assert.ok(view.rows().some(row=>row.dataset.mid==="m100"));
    await view.jump("newest",true);
    await act(async()=>restoreTranscriptPosition(position)); await view.flush();
    assert.equal(view.rows().at(-1)?.dataset.mid,"m999");
    assert.equal(view.viewport().scrollTop,view.viewport().scrollHeight-view.viewport().clientHeight);
    await view.jump("oldest",true);
    await act(async()=>restoreTranscriptPosition({...position,anchorId:"m800"})); await view.flush();
    assert.equal(view.rows()[0]?.dataset.mid,"m0"); assert.equal(view.viewport().scrollTop,0);
    await view.render({messages:messages(200)}); assert.equal(view.rows()[0]?.dataset.mid,"m0");
    assert.ok(view.rows().length<=100); assert.deepEqual(view.calls,[]);
  } finally { await view.close(); }
  const reopened = await setup();
  try { assert.equal(reopened.rows().length,50,"an ignored stale checkpoint is not queued for the next mount"); } finally { await reopened.close(); }
});

test("explicit Newest follows content growth despite the prior scroll guard, until the reader moves away", async () => {
  const view = await setup();
  try {
    await act(async()=>view.viewport().dispatchEvent(new view.dom.window.WheelEvent("wheel",{bubbles:true,deltaY:-20})));
    view.viewport().scrollTop = 200;
    await act(async()=>view.viewport().dispatchEvent(new view.dom.window.Event("scroll",{bubbles:true})));
    let guardBlocked = 0;
    Object.defineProperty(view.viewport(),"scrollTo",{configurable:true,value:()=>{guardBlocked++;}});
    await view.jump("newest"); await view.flush();
    const next = {...messages(1,1000)[0]!,role:"user" as const};
    await view.render({messages:[...view.api().messages,next],isStreaming:true,streamingContent:"A growing reply"});
    assert.ok(guardBlocked>0,"the ordinary programmatic scroll path remains guarded");
    await view.grow(800);
    assert.equal(view.viewport().scrollTop,view.viewport().scrollHeight-view.viewport().clientHeight,"explicit latest intent follows taller streamed/image content through the built-in native path");
    await act(async()=>view.viewport().dispatchEvent(new view.dom.window.WheelEvent("wheel",{bubbles:true,deltaY:-20})));
    view.viewport().scrollTop = 100;
    await act(async()=>view.viewport().dispatchEvent(new view.dom.window.Event("scroll",{bubbles:true})));
    await view.grow(400);
    assert.equal(view.viewport().scrollTop,100,"fresh reading intent ends latest following");
  } finally { await view.close(); }
});

test("1000 loaded messages stay bounded while navigating older and newer windows", async ctx => {
  const view = await setup();
  try {
    assert.equal(view.rows().length, 50);
    let peak = 50;
    await view.older(); assert.equal(view.rows().length, 100);
    for (let i = 0; i < 20 && view.container.textContent?.includes(t("loadEarlier")); i++) { await view.older(); peak = Math.max(peak, view.rows().length); assert.ok(view.rows().length <= 100); }
    assert.equal(view.rows()[0]?.dataset.mid, "m0");
    assert.ok(!view.rows().some(row => row.dataset.mid === "m999"));
    for (let i = 0; i < 20 && view.container.querySelector('[data-history-direction="newer"]'); i++) { await view.newer(); peak = Math.max(peak, view.rows().length); assert.ok(view.rows().length <= 100); }
    assert.equal(view.rows().at(-1)?.dataset.mid, "m999");
    assert.deepEqual(view.calls, []);
    assert.equal(view.api().messages.length, 1000, "Windowing never deletes loaded message data");
    ctx.diagnostic(JSON.stringify({ loadedRows: 1000, initialMountedRows: 50, peakMountedHistoryRows: peak, measurement: "actual JSDOM row count through older/newer transitions" }));
  } finally { await view.close(); }
});

test("window changes preserve a retained visible row in a creator-owned nested viewport", async () => {
  const view = await setup(1000, [], true);
  try {
    const anchor = view.rows()[0]!, id = anchor.dataset.mid!, before = anchor.getBoundingClientRect().top;
    await view.older();
    const after = view.rows().find(row => row.dataset.mid === id)!;
    assert.equal(after.getBoundingClientRect().top, before);
    assert.equal(view.viewport().scrollTop, 2000);
  } finally { await view.close(); }
});

test("editing pins its row and draft while appends arrive; branch truncation and session resets stay bounded", async () => {
  const view = await setup();
  try {
    const row = view.rows()[0]!, id = row.dataset.mid!;
    await act(async () => row.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
    const textarea = row.querySelector<HTMLTextAreaElement>("textarea")!; assert.ok(textarea);
    const setter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(textarea, "My preserved draft"); textarea.dispatchEvent(new view.dom.window.Event("input", { bubbles: true })); });
    await view.older(); assert.equal(view.rows()[0]?.dataset.mid, id, "Paging cannot unmount an edit");
    await view.render({ messages: [...view.api().messages, ...messages(100, 1000)] });
    assert.ok(view.rows().some(row => row.dataset.mid === id));
    assert.equal(view.container.querySelector("textarea")?.value, "My preserved draft");
    await view.render({ messages: messages(20) }); assert.ok(view.rows().length <= 100);
    await view.render({ sessionId: "another", messages: messages(1000) }); assert.equal(view.rows().length, 50);
  } finally { await view.close(); }
});


test("a restored history checkpoint mounts only its bounded anchor window", async () => {
  const view = await setup();
  try {
    const { restoreTranscriptPosition } = await import("../../../sandbox/chat/transcript-position");
    await act(async () => restoreTranscriptPosition({ version: 1, sessionId: "fixture", mode: "reading", anchorId: "m100", offset: -20, top: 4000, expanded: true, loadedCount: 1000 }));
    await view.flush();
    const row = view.rows().find(candidate => candidate.dataset.mid === "m100");
    assert.ok(row); assert.equal(row.getBoundingClientRect().top, -20); assert.equal(view.rows().length, 100);
    assert.deepEqual(view.calls, []);
  } finally { await view.close(); }
});

test("a delayed server prepend reveals a bounded older page and retains the reading anchor", async () => {
  const view = await setup(40);
  let finish: (value: boolean) => void = () => {};
  try {
    await view.render({ hasEarlierMessages: true, loadEarlierMessages: () => new Promise<boolean>(resolve => { finish = resolve; }) });
    const anchor = view.rows()[0]!.dataset.mid!;
    await view.older();
    await view.render({ messages: [...messages(200, -200), ...messages(40)], hasEarlierMessages: false });
    await act(async () => finish(true));
    assert.ok(view.rows().length <= 100);
    const row = view.rows().find(candidate => candidate.dataset.mid === anchor); assert.ok(row);
    assert.equal(row.getBoundingClientRect().top, 0);
    assert.ok(view.rows().some(candidate => candidate.dataset.mid?.startsWith("m-")));
  } finally { await view.close(); }
});

test("manual reading stays on the same rows when new replies and a stream arrive", async () => {
  const view = await setup();
  try {
    await act(async () => view.viewport().dispatchEvent(new view.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -20 })));
    view.viewport().scrollTop = 200;
    await act(async () => view.viewport().dispatchEvent(new view.dom.window.Event("scroll", { bubbles: true })));
    const first = view.rows()[0]!.dataset.mid;
    await view.render({ messages: [...view.api().messages, ...messages(100, 1000)], isStreaming: true, streamingContent: "New live reply" });
    assert.equal(view.rows()[0]!.dataset.mid, first);
    assert.ok(!view.container.textContent?.includes("New live reply"), "A detached live row cannot break historical continuity");
    assert.ok(view.container.querySelector('[data-history-direction="newer"]'));
  } finally { await view.close(); }
});


test("manual Newer keeps its historical anchor pinned across appends until bottom input", async () => {
  const view = await setup(1000, [], true);
  try {
    await view.older(); await view.older();
    view.viewport().scrollTop = 3800;
    await view.newer();
    const before = view.rows().find(row => row.dataset.mid === "m945"); assert.ok(before);
    assert.equal(before.getBoundingClientRect().top, 0);
    await view.render({ messages: [...view.api().messages, ...messages(100, 1000)], isStreaming: true, streamingContent: "Live continuation" });
    const anchor = view.rows().find(row => row.dataset.mid === "m945"); assert.ok(anchor, "Appending cannot discard the reading anchor after Newer");
    assert.equal(anchor.getBoundingClientRect().top, 0);
    assert.ok(!view.container.textContent?.includes("Live continuation"));
    await view.newer(); await view.newer();
    await act(async () => view.viewport().dispatchEvent(new view.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: 20 })));
    view.viewport().scrollTop = view.viewport().scrollHeight - view.viewport().clientHeight;
    await act(async () => view.viewport().dispatchEvent(new view.dom.window.Event("scroll", { bubbles: true })));
    await view.render({ messages: [...view.api().messages, ...messages(5, 1100)], isStreaming: false });
    assert.equal(view.rows().at(-1)?.dataset.mid, "m1104", "Physical bottom input resumes following new replies");
  } finally { await view.close(); }
});
