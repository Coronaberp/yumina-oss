import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradeVnCharacterMentionFiles } from "./vn-character-mention-upgrade";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]));
const content = '*Sera smiles at you. Seraphine carries a book.*\n\n[SPEAKER:Sera:normal] "Diane, meet Sera."\n\n*LATER_SECRET Sera is the queen.*';
type CompleteRequest = { includeLorebook: boolean; maxTokens: number; messages: { role: string; content: string }[] };
type FixtureMessage = { id: string; role: string; content: string; activeSwipeIndex?: number; swipes?: Record<string, unknown>[] };
async function fixture(extra: Record<string, unknown> = {}, configOverride?: string, interfaceFiles = files) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: CompleteRequest[] = [], pending: ((value: string) => void)[] = [];
  const api: Record<string, unknown> & { messages: FixtureMessage[] } = {
    sessionId: "viewer", worldId: "world", worldName: "Academy", readOnly: false, isStreaming: false,
    variables: { "rel-sera": 15, "sera-hp": 40, "secret-sera": "HIDDEN_STAT", "hp": 100, "vn-sprites": { "Sera (Seraphine)": { normal: "/normal.png", happy: "/happy.png" } } },
    getVisibleVariables: async () => ({ "rel-sera":15, "sera-hp":40, hp:100 }),
    entries: [{ id: "sera", name: "Sera (Seraphine)", role: "character", content: "HIDDEN_PROFILE secret queen" }, { id: "diane", name: "Diane Bluerose", role: "character", content: "SECRET_BACKSTORY" }],
    messages: [{ id: "system", role: "system", content: "SYSTEM_SECRET" }, { id: "old", role: "assistant", content: '*Sera gave you a book. PREVIOUS_REVEALED*' }, { id: "m1", role: "assistant", content, activeSwipeIndex: 0, swipes: [{ content, reasoningContent: "HIDDEN_THOUGHTS", rawContent: content + "\nHIDDEN_METADATA" }, { content: "INACTIVE_SECRET" }] }, { id: "future", role: "assistant", content: '*FUTURE_SECRET*' }],
    storage: { get: async (key: string) => key.endsWith(":cursor") ? JSON.stringify({ turn: "m1:0", index: 0 }) : null, set: async () => {} },
    renderMarkdown: (value: string) => marked.parse(value), resolveAssetUrl: (value: string) => value,
    ai: { complete: (params: CompleteRequest) => { calls.push(params); return new Promise<string>(resolve => pending.push(resolve)); } },
    ...extra,
  };
  const config = 'export const statusConfig = {title:"Status",groups:[{id:"relationships",label:"Relationships"},{id:"vitals",label:"Vitals"}],fields:[{id:"r",label:"Sera",variableId:"rel-sera",path:"",group:"relationships",min:-100,max:100},{id:"hp",label:"Sera HP",variableId:"sera-hp",path:"",group:"vitals"},{id:"s",label:"Sera secret",variableId:"secret-sera",path:"",group:"vitals"},{id:"player",label:"HP",variableId:"hp",group:"vitals"}]};';
  const result = bundleAndCompile({ files: { ...interfaceFiles, "status-config.ts": configOverride || config }, entryFile: "index.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!, root = createRoot(container);
  const render = async () => { await act(async () => root.render(createElement(result.Component!))); };
  await render();
  const click = async (selector: string) => { const node = container.querySelector<HTMLButtonElement>(selector); assert.ok(node, selector); await act(async () => node.click()); };
  return { api, dom, container, render, click, calls, pending, dispose: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, desc] of originals) { if (desc) Object.defineProperty(globalThis, key, desc); else Reflect.deleteProperty(globalThis, key); } } };
}

test("character viewer generates once on click with revealed evidence, sprites and public character stats", async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0);
    const position = f.container.querySelector('.vn-progress')!.textContent;
    assert.equal(f.container.querySelectorAll('.vn-dialogue .vn-character-link').length, 2);
    await act(async () => { const name = f.container.querySelector<HTMLButtonElement>('.vn-dialogue .vn-character-link')!; name.click(); name.click(); });
    assert.equal(f.calls.length, 1);
    assert.equal(f.container.querySelector('.vn-progress')!.textContent, position);
    const prompt = JSON.stringify(f.calls[0]);
    assert.match(prompt, /PREVIOUS_REVEALED/); assert.match(prompt, /Sera smiles/);
    for (const secret of ["LATER_SECRET", "FUTURE_SECRET", "HIDDEN_PROFILE", "SECRET_BACKSTORY", "INACTIVE_SECRET", "SYSTEM_SECRET", "HIDDEN_THOUGHTS", "HIDDEN_METADATA", "HIDDEN_STAT"]) assert.ok(!prompt.includes(secret), secret);
    assert.equal(f.calls[0].includeLorebook, false);
    assert.ok(f.calls[0].maxTokens >= 2048, "reasoning models need room to finish before writing the summary");
    const viewer = f.container.querySelector('[aria-label="Character viewer"]')!;
    assert.ok(viewer); assert.match(viewer.textContent!, /Generating/);
    assert.match(viewer.textContent!, /15/); assert.match(viewer.textContent!, /40/); assert.ok(!viewer.textContent!.includes("HIDDEN_STAT")); assert.ok(!viewer.textContent!.includes("100"), "player HP excluded");
    assert.equal(viewer.querySelector('img')!.getAttribute('src'), '/normal.png');
    await f.click('[aria-label="View happy sprite"]');
    assert.equal(viewer.querySelector('img')!.getAttribute('src'), '/happy.png'); assert.equal(f.calls.length, 1);
    await act(async () => f.pending[0]('- Gave you a book.\n- Smiled at you.'));
    assert.equal(viewer.querySelectorAll('.vn-character-summary li').length, 2);
    assert.equal(f.dom.window.document.activeElement?.getAttribute('aria-label'), 'Close character viewer');
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(f.container.querySelector('[aria-label="Character viewer"]'), null);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.dom.window.document.activeElement?.className, 'vn-character-link');
  } finally { await f.dispose(); }
});

test("mention matching preserves markdown, ignores ambiguous aliases, links and code, and uses word boundaries", async () => {
  const text = '*Sera and **Diane Bluerose** greet Diane. Anna watches Annabel. `Sera` [Sera](/link) <span title="Sera">Seraphine</span>*';
  const f = await fixture({ entries: [{ id:'s',name:'Sera (Seraphine)',role:'character' },{id:'d',name:'Diane Bluerose (Diane)',role:'character'},{id:'a',name:'Anna Rose',role:'character'},{id:'b',name:'Anna Stone',role:'character'}], messages: [{ id:'m1',role:'assistant',content:text }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(n => n.textContent), ['Sera','Diane Bluerose','Diane','Seraphine']);
    assert.ok(f.container.querySelector('strong .vn-character-link'));
    assert.equal(f.container.querySelector('a .vn-character-link'), null); assert.equal(f.container.querySelector('code .vn-character-link'), null);
  } finally { await f.dispose(); }
});

test("inferred character name fragments do not link descriptions in the story or log", async () => {
  const text = '*An eager woman with short black hair visits a black-haired vendor in the black market garden. Black and Garden are ordinary words here. Diane greets Bluerose, dIaNe BlUeRoSe and bLaCk GaRdEn. Sera and sErApHiNe wave. An NPC visits the Annex.*';
  const f = await fixture({ entries: [
    { id: 'garden', name: 'Black Garden', role: 'character' },
    { id: 'diane', name: 'Diane Bluerose (Diane)', role: 'character' },
    { id: 'sera', name: 'Sera (Seraphine)', role: 'character' },
    { id: 'npc', name: 'NPC', role: 'character', enabled: false },
    { id: 'annex', name: 'Annex', role: 'location' },
  ], messages: [{ id: 'm1', role: 'assistant', content: text }] });
  try {
    const linked = (selector: string) => Array.from(f.container.querySelectorAll(selector + ' .vn-character-link')).map(node => node.textContent);
    const expected = ['Diane', 'dIaNe BlUeRoSe', 'bLaCk GaRdEn', 'Sera', 'sErApHiNe'];
    assert.deepEqual(linked('.vn-dialogue'), expected);
    await f.click('[aria-label="Log"]');
    assert.deepEqual(linked('.vn-log'), expected);
    await f.click('.vn-log .vn-character-link');
    assert.equal(f.container.querySelector('.vn-character-card h1')!.textContent, 'Diane');
    assert.match(JSON.stringify(f.calls[0]), /Diane/);
  } finally { await f.dispose(); }
});

test("complete authored aliases stay case-insensitive without promoting their individual words", async () => {
  const text = '*The garden queen of night wears a cloak of silk and greets BLACK GARDEN and qUeEn oF nIgHt. Night and Garden answer.*';
  const f = await fixture({ entries: [{ id: 'garden', name: 'Black Garden (Queen of Night)', role: 'character' }], messages: [{ id: 'm1', role: 'assistant', content: text }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['queen of night', 'BLACK GARDEN', 'qUeEn oF nIgHt']);
  } finally { await f.dispose(); }
});

test("an authored single-word character name still links in lowercase", async () => {
  const f = await fixture({ entries: [{ id: 'black', name: 'Black', role: 'character' }], messages: [{ id: 'm1', role: 'assistant', content: '*black waits.*' }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['black']);
    await f.click('.vn-dialogue .vn-character-link');
    assert.equal(f.container.querySelector('.vn-character-card h1')!.textContent, 'black');
  } finally { await f.dispose(); }
});

test("lowercase-authored complete names do not make their individual words character links", async () => {
  const f = await fixture({ entries: [{ id: 'garden', name: 'black garden', role: 'character' }], messages: [{ id: 'm1', role: 'assistant', content: '*A black coat in the garden belongs to BLACK GARDEN.*' }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['BLACK GARDEN']);
  } finally { await f.dispose(); }
});

test("multiword personal names link in full and accept explicitly authored short aliases", async () => {
  const f = await fixture({ entries: [
    { id: 'diane', name: 'Diane Bluerose', role: 'character' },
    { id: 'mei', name: 'Mei Amery (Mei)', role: 'character' },
  ], messages: [{ id: 'm1', role: 'assistant', content: '*Diane and Bluerose greet dIaNe BlUeRoSe. mEi and MEI AMERY answer.*' }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['dIaNe BlUeRoSe', 'mEi', 'MEI AMERY']);
  } finally { await f.dispose(); }
});

test("discarded name fragments do not suppress another character's authored alias", async () => {
  const f = await fixture({ entries: [
    { id: 'mei', name: 'Mei Amery (Mei)', role: 'character' },
    { id: 'ling', name: 'Mei Ling', role: 'character' },
    { id: 'a', name: 'A (Black)', role: 'character' },
    { id: 'garden', name: 'Black Garden', role: 'character' },
  ], messages: [{ id: 'm1', role: 'assistant', content: '*Mei greets bLaCk beneath Black Garden. Mei Ling waits.*' }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['Mei', 'bLaCk', 'Black Garden', 'Mei Ling']);
  } finally { await f.dispose(); }
});

test("a short alias authored for multiple characters remains ambiguous", async () => {
  const f = await fixture({ entries: [
    { id: 'rose', name: 'Anna Rose (Anna)', role: 'character' },
    { id: 'stone', name: 'Anna Stone (Anna)', role: 'character' },
  ], messages: [{ id: 'm1', role: 'assistant', content: '*Anna greets Anna Rose and ANNA STONE.*' }] });
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['Anna Rose', 'ANNA STONE']);
  } finally { await f.dispose(); }
});

test("saved stock character viewers receive the complete-name matching policy at render time", async () => {
  const legacyCopy = readFileSync(new URL('./test-fixtures/vn-character-copy-legacy.txt', import.meta.url), 'utf8').trimEnd();
  const legacyViewer = files['character-viewer.tsx'].replace(/export function CharacterCopy\([\s\S]*?\n\}(?=\n\nfunction visibleText\()/, legacyCopy);
  const upgraded = upgradeVnCharacterMentionFiles({ ...files, 'character-viewer.tsx': legacyViewer }, files['character-viewer.tsx']);
  const f = await fixture({ entries: [{ id: 'garden', name: 'Black Garden', role: 'character' }], messages: [{ id: 'm1', role: 'assistant', content: '*Black hair, black-haired, black market, Garden and garden describe the scene. bLaCk GaRdEn speaks.*' }] }, undefined, upgraded);
  try {
    assert.deepEqual(Array.from(f.container.querySelectorAll('.vn-dialogue .vn-character-link')).map(node => node.textContent), ['bLaCk GaRdEn']);
    await f.click('.vn-dialogue .vn-character-link');
    assert.equal(f.container.querySelector('.vn-character-card h1')!.textContent, 'bLaCk GaRdEn');
  } finally { await f.dispose(); }
});

test("open character viewer refreshes pending sprite URLs when sandbox assets become ready", async () => {
  const pendingImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  let assetsReady = false;
  const f = await fixture({ resolveAssetUrl: (ref: string) => assetsReady ? ref : pendingImage });
  try {
    await f.click('.vn-dialogue .vn-character-link');
    const viewer = f.container.querySelector('[aria-label="Character viewer"]')!;
    assert.equal(viewer.querySelector('img')!.getAttribute('src'), pendingImage);
    assetsReady = true;
    await f.render();
    assert.equal(viewer.querySelector('img')!.getAttribute('src'), '/normal.png');
    await f.click('[aria-label="View happy sprite"]');
    assert.equal(viewer.querySelector('img')!.getAttribute('src'), '/happy.png');
    assert.equal(f.calls.length, 1, 'Resolving sprites does not regenerate the story summary');
  } finally { await f.dispose(); }
});

test("viewer retries bridge errors and ignores late responses after closing or branch changes", async () => {
  const f = await fixture();
  try {
    await f.click('.vn-dialogue .vn-character-link');
    await act(async () => f.pending[0]('[Error: Provider unavailable]'));
    assert.ok(f.container.querySelector('[role="alert"]'));
    assert.match(f.container.querySelector('[role="alert"]')!.textContent!, /Provider unavailable/);
    await act(async () => { const retry = f.container.querySelector<HTMLButtonElement>('[aria-label="Retry character summary"]')!; retry.click(); retry.click(); }); assert.equal(f.calls.length, 2);
    await f.click('[aria-label="Close character viewer"]');
    await f.click('.vn-dialogue .vn-character-link'); assert.equal(f.calls.length, 3);
    await act(async () => f.pending[1]('- STALE_RESULT'));
    assert.ok(!f.container.textContent!.includes('STALE_RESULT'));
    f.api.messages[2] = { ...f.api.messages[2], activeSwipeIndex: 1 }; await f.render();
    assert.equal(f.container.querySelector('[aria-label="Character viewer"]'), null);
    await act(async () => f.pending[2]('- BRANCH_STALE'));
    assert.ok(!f.container.textContent!.includes('BRANCH_STALE'));
  } finally { await f.dispose(); }
});

test("log viewer preserves filters and cuts evidence at the original passage even when earlier rows are filtered", async () => {
  const f = await fixture();
  try {
    await f.click('[aria-label="Log"]');
    const select = f.container.querySelector<HTMLSelectElement>('[aria-label="Filter by turn"]')!;
    await act(async () => { select.value = 'm1'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles:true })); });
    await f.click('.vn-log .vn-character-link');
    assert.ok(!JSON.stringify(f.calls[0]).includes('LATER_SECRET'));
    await f.click('[aria-label="Close character viewer"]');
    assert.equal(select.value, 'm1'); assert.ok(f.container.querySelector('.vn-log'));
  } finally { await f.dispose(); }
});

test("guest viewer does not request AI and unknown visibility metadata hides stats", async () => {
  const f = await fixture({ sessionId:'',readOnly:true,getVisibleVariables:undefined });
  try { await f.click('.vn-dialogue .vn-character-link'); assert.equal(f.calls.length, 0); assert.ok(!f.container.querySelector('.vn-character-stats')?.textContent?.includes('40')); assert.match(f.container.querySelector('[aria-label="Character viewer"]')!.textContent!, /Start a story/); }
  finally { await f.dispose(); }
});

test("viewer excludes character-to-character relationships and ambiguous stat ownership", async () => {
  const config = 'export const statusConfig = {fields:[{id:"cross",label:"Sera trust in Ryu",variableId:"rel-sera-ryu",group:"relationships"},{id:"other",label:"Sera friendship",variableId:"npc-friendship",group:"relationships"},{id:"shared",label:"Sera and Ryu power",variableId:"shared-power",group:"vitals"},{id:"own",label:"Sera HP",variableId:"sera-hp",group:"vitals"}]};';
  const f = await fixture({ entries:[{id:"sera",name:"Sera",role:"character"},{id:"ryu",name:"Ryu",role:"character"}],getVisibleVariables:async () => ({"rel-sera-ryu":777,"npc-friendship":888,"shared-power":999,"sera-hp":40}) }, config);
  try {
    await f.click('.vn-dialogue .vn-character-link');
    const viewer = f.container.querySelector('[aria-label="Character viewer"]')!;
    assert.match(viewer.textContent!, /40/);
    for (const value of ['777','888','999']) assert.ok(!viewer.textContent!.includes(value), value);
    assert.match(viewer.textContent!, /No relationship stat available/);
  } finally { await f.dispose(); }
});

test("structured latest passages use their displayed cutoff rather than whole message text", async () => {
  const f = await fixture({ messages:[{id:"m1",role:"assistant",content:'*MESSAGE_SECRET*'}],variables:{segments:[{speaker:"Narrator",text:"Sera hands you a letter."},{speaker:"Narrator",text:"SEGMENT_SECRET Sera leaves."}]},getVisibleVariables:async () => ({}) });
  try {
    await f.click('.vn-dialogue .vn-character-link');
    const prompt = JSON.stringify(f.calls[0]);
    assert.match(prompt,/Sera hands/); assert.ok(!prompt.includes('MESSAGE_SECRET')); assert.ok(!prompt.includes('SEGMENT_SECRET'));
  } finally { await f.dispose(); }
});

test("summary attributes dialogue to the clicked character without adding an unrevealed profile name", async () => {
  const f = await fixture({messages:[{id:"m1",role:"assistant",content:'[SPEAKER:Sera:normal] "I carry a book for Sera."'}]});
  try {
    await f.click('.vn-dialogue .vn-character-link');
    const prompt = JSON.stringify(f.calls[0]);
    assert.match(prompt,/Sera says: I carry a book/);
    assert.ok(!prompt.includes('Seraphine'));
    assert.equal(f.container.querySelector('.vn-character-card h1')!.textContent,'Sera');
  } finally {await f.dispose();}
});

test("character recap loads saved character history beyond pagination using the session summary model", async () => {
  const historyCalls: unknown[][] = [];
  const f = await fixture({ hasEarlierMessages: true, getCharacterHistory: async (...args: unknown[]) => {
    historyCalls.push(args);
    return { text: 'Sera helped the player at the OLD_UNLOADED_LIBRARY_SCENE.', partial: false, model: 'configured-summary-model', language: 'en' };
  } });
  try {
    await f.click('.vn-dialogue .vn-character-link');
    assert.deepEqual(historyCalls, [['sera', 'm1', 'Sera', 0]]);
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0] as CompleteRequest & {model?: string}).model, 'configured-summary-model');
    const prompt = JSON.stringify(f.calls[0]);
    assert.match(prompt, /OLD_UNLOADED_LIBRARY_SCENE/);
    assert.match(prompt, /Sera smiles/);
    for (const hidden of ['LATER_SECRET', 'FUTURE_SECRET', 'HIDDEN_PROFILE', 'HIDDEN_THOUGHTS', 'HIDDEN_METADATA']) assert.ok(!prompt.includes(hidden), hidden);
  } finally { await f.dispose(); }
});

test("failed character-history retrieval offers retry without generating a misleading recent-excerpt recap", async () => {
  const f = await fixture({ getCharacterHistory: async () => { throw new Error('Saved character history is unavailable'); } });
  try {
    await f.click('.vn-dialogue .vn-character-link');
    assert.equal(f.calls.length, 0);
    assert.match(f.container.querySelector('[role="alert"]')?.textContent || '', /Saved character history is unavailable/);
    assert.ok(f.container.querySelector('[aria-label="Retry character summary"]'));
  } finally { await f.dispose(); }
});
