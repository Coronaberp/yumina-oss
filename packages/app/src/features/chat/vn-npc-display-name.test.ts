import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { slimMessages } from "./slim-messages";

const directory = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(directory).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(directory + name, "utf8")]));
const clerk = (text: string, id = "clerk") => `[SPEAKER:NPC:normal:male:${id}] "${text}"`;
const reply = (id: string, content: string, extra = {}) => ({ id, role: "assistant", content, ...extra });

function probe(messages: object[], target = messages.length - 1, limit?: number, extra = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const result = bundleAndCompile({ files: { ...files, "probe.tsx": `import { messagePassages } from "./passages"; import { npcSpeakerLabels } from "./npc-display-name"; import { spriteKey, spriteFor } from "./sprites"; export default function Probe(){ const api=useYumina(); const message=api.messages[api.target]; const lines=messagePassages(api,message).slice(0,api.limit); const before=JSON.stringify(lines); const labels=npcSpeakerLabels(api,message,lines); return <pre>{JSON.stringify({labels,lines,unchanged:before===JSON.stringify(lines),keys:lines.map(spriteKey),sprites:api.skipSpriteProbe?[]:lines.map(line=>spriteFor(api,line))})}</pre>; }` }, entryFile: "probe.tsx" }, () => ({ sessionId: 'npc-label-test', entries: [], variables: {}, resolveAssetUrl: (value: string) => value, messages, target, limit, ...extra }));
    assert.equal(result.error, null, result.error ?? undefined);
    const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
    const output = JSON.parse(dom.window.document.querySelector("pre")!.textContent!);
    dom.window.close();
    return output;
  } finally {
    if (original) Object.defineProperty(globalThis, "React", original);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

test("an NPC earns its visible alias only after its own explicit introduction", () => {
  const result = probe([reply('one', clerk('My name is Rook.') + '\n\n' + clerk('Welcome.'))]);
  assert.deepEqual(result.labels, ['NPC', 'Rook']);
  assert.deepEqual(result.lines.map((line: { name: string }) => line.name), ['NPC', 'NPC']);
  assert.deepEqual(result.keys, ['npc:male:clerk', 'npc:male:clerk']);
  assert.equal(result.sprites[0], result.sprites[1]);
  assert.equal(result.unchanged, true);
});

test("Sable's displayed Turn 4 introduction earns her Turn 14 NPC label", () => {
  // Selected, displayed excerpts from the playtest; hidden/raw names are not inputs.
  const opening = `[SPEAKER:NPC:normal:female:academy-firstyear-copper]
"You're the relay." *The grin widens. Copper hair, cut short and uneven at the jaw, and a smear of something dark on one cheekbone that might be grease or might be dried blood.* "Word travels fast in a chamber with good acoustics. I'm Sable. First-year, no team, no CODE worth mentioning yet—" *Sable lifts a bare key-drive between two fingers and waggles it* "—they're still deciding whether I get one at all."`;
  const later = `[SPEAKER:NPC:normal:female:academy-firstyear-copper]
"Then don't put the post where they can see it." *Sable says it flatly, as though it were obvious.* "Sector four's got a maintenance run under the wall—old cable conduit, they use it for the sensor grid. It's not on the patrol route. Put the listening post down there and the patrol never has to know who's in it." *Sable's arms uncross.* "I know because I've been walking the maintenance runs since I got here. There's nothing else to do when you haven't got a team."`;
  const messages = [reply('turn4', opening), reply('turn14', later)];
  const first = probe(messages, 0);
  const introduction = first.lines.findIndex((line: { text: string }) => line.text.includes("I'm Sable."));
  assert.ok(introduction >= 0);
  assert.equal(first.labels[introduction], 'NPC');
  assert.ok(first.labels.slice(introduction + 1).includes('Sable'));
  const result = probe(messages);
  assert.ok(result.lines.filter((line: { kind: string }) => line.kind === 'dialogue').length > 0);
  result.lines.forEach((line: { kind: string; name: string }, index: number) => {
    if (line.kind === 'dialogue') { assert.equal(result.labels[index], 'Sable'); assert.equal(line.name, 'NPC'); }
  });
  assert.ok(result.keys.filter((key: string) => key.startsWith('npc:')).every((key: string) => key === 'npc:female:academy-firstyear-copper'));
  assert.equal(result.unchanged, true);
});

test("sentence-boundary first-person introductions support curly apostrophes and I am", () => {
  for (const introduction of ['I’m Rook.', 'I am Rook.', "Welcome. I'm Rook.", 'Welcome! I am Rook. Follow me.']) {
    assert.deepEqual(probe([reply('one', clerk(introduction) + '\n\n' + clerk('Welcome.'))]).labels, ['NPC', 'Rook'], introduction);
  }
});

test("new introduction forms cannot name an NPC from reports, questions, roles or descriptions", () => {
  for (const text of [
    "She said, ‘Welcome. I'm Hidden.’", 'He said, “Welcome. I am Hidden.”', 'She said: I am Hidden.',
    "He once said I'm Hidden.", "I'm Rook?", 'I am a registrar.', "I'm tired.", 'I am ready.',
    "A sample: `Welcome. I'm Hidden.`", "A sample: [Welcome. I'm Hidden.](https://example.com)",
    "A sample. <span hidden>Welcome. I'm Hidden.</span>",
  ]) assert.deepEqual(probe([reply('one', clerk(text) + '\n\n' + clerk('Welcome.'))]).labels, ['NPC', 'NPC'], text);
});

test("sentence introductions obey reading cutoffs, active swipes and conflicting disclosures", () => {
  const content = clerk('Welcome.') + '\n\n' + clerk("Good acoustics. I'm Rook.") + '\n\n' + clerk('Follow me.');
  const messages = [reply('one', content)];
  assert.deepEqual(probe(messages, 0, 1).labels, ['NPC']);
  assert.deepEqual(probe(messages).labels, ['NPC', 'NPC', 'Rook']);
  assert.deepEqual(probe(messages, 0, 1).labels, ['NPC']);
  const other = reply('two', clerk('Welcome.'));
  assert.deepEqual(probe([messages[0], other]).labels, ['Rook']);
  const replacement = reply('one', clerk('A different branch.'), { activeSwipeIndex: 1, swipes: [{ content }, { content: clerk('A different branch.') }] });
  assert.deepEqual(probe([replacement, other]).labels, ['NPC']);
  assert.deepEqual(probe([reply('one', clerk("I'm Rook. I am Vale.") + '\n\n' + clerk('Welcome.'))]).labels, ['NPC', 'NPC']);
  assert.deepEqual(probe([reply('one', clerk("My name is Rook. I am Vale.") + '\n\n' + clerk('Welcome.'))]).labels, ['NPC', 'NPC']);
});

test("reported introductions stay literal across dialogue pagination", () => {
  for (const padding of [7, 14]) {
    const report = "He said, ‘" + 'We waited in that silent corridor for several minutes. '.repeat(padding)
      + "Welcome. I'm Hidden. " + 'We waited in that silent corridor for several minutes. '.repeat(padding) + 'I leave now.’';
    const content = clerk(report) + '\n\n' + clerk('Follow me.');
    const result = probe([reply('report', content)]);
    assert.ok(result.labels.length > 3);
    assert.ok(result.labels.every((label: string) => label === 'NPC'));
    assert.deepEqual(probe([reply('report', content), reply('later', clerk('Follow me.'))]).labels, ['NPC']);
    const ownIntroduction = content + '\n\n' + clerk("I'm Rook.") + '\n\n' + clerk('Welcome.');
    assert.equal(probe([reply('one', ownIntroduction)]).labels.at(-1), 'Rook');
  }
});

test("HTML-bearing dialogue remains conservative across pagination", () => {
  const padding = 'We waited in that silent corridor for several minutes. '.repeat(7);
  const content = clerk('<span hidden>' + padding + "Welcome. I'm Hidden. I leave now. " + padding + '</span>') + '\n\n' + clerk('Follow me.');
  const result = probe([reply('html', content)]);
  assert.ok(result.labels.length > 3);
  assert.ok(result.labels.every((label: string) => label === 'NPC'));
});

test("future pages, cursor rewinds and future greetings do not disclose an NPC alias", () => {
  const content = clerk('Welcome.') + '\n\n' + clerk('Call me Rook.') + '\n\n' + clerk('Follow me.');
  const messages = [reply('greeting', content)];
  assert.deepEqual(probe(messages, 0, 1).labels, ['NPC']);
  assert.deepEqual(probe(messages).labels, ['NPC', 'NPC', 'Rook']);
  assert.deepEqual(probe(messages, 0, 1).labels, ['NPC']);
  assert.deepEqual(probe([reply('old', clerk('Welcome.')), ...messages], 0).labels, ['NPC']);
});

test("a disclosed alias follows only its stable NPC identity into later active replies", () => {
  const messages = [reply('one', clerk('Call me Rook.')), reply('two', clerk('Welcome.') + '\n\n' + clerk('A different person.', 'guard'))];
  assert.deepEqual(probe(messages).labels, ['Rook', 'NPC']);
  assert.deepEqual(probe([reply('other-session', clerk('Welcome.'))]).labels, ['NPC']);
});

test("inactive swipes, raw provider text, user claims and lore profiles cannot earn aliases", () => {
  const current = reply('one', clerk('Welcome.'), { activeSwipeIndex: 1, swipes: [{ content: clerk('My name is Hidden.') }, { content: clerk('Welcome.'), rawContent: clerk('My name is RawSecret.') }] });
  const messages = [{ id: 'user', role: 'user', content: clerk('My name is PlayerClaim.') }, current, reply('two', clerk('Follow me.'))];
  const extra = { entries: [{ id: 'secret', name: 'Secret Canonical Identity', role: 'lore', content: 'My name is ProfileSecret.' }] };
  assert.deepEqual(probe(messages, 2, undefined, extra).labels, ['NPC']);
  const introduced = [reply('one', clerk('My name is Rook.'), { activeSwipeIndex: 0 }), reply('two', clerk('Welcome.'))];
  assert.deepEqual(probe(introduced).labels, ['Rook']);
  introduced[0] = current;
  assert.deepEqual(probe(introduced).labels, ['NPC']);
});

test("stale message content cannot retain a name absent from its selected swipe", () => {
  const previous = reply('one', clerk('My name is Rook.'), { activeSwipeIndex: 1, swipes: [
    { content: clerk('My name is Rook.') }, { content: clerk('Welcome.') },
  ] });
  const messages = slimMessages([previous, reply('two', clerk('Follow me.'))]);
  assert.deepEqual(probe(messages).labels, ['NPC']);
  const staleCurrent = { ...previous, content: clerk('My name is Rook.') + '\n\n' + clerk('Follow me.') };
  assert.deepEqual(probe(slimMessages([staleCurrent])).labels, ['NPC', 'NPC']);
});

test("other actors, unnamed NPCs and conflicting introductions retain generic labels", () => {
  assert.deepEqual(probe([reply('one', clerk('My name is Rook.') + '\n\n' + clerk('Welcome.', 'guard'))]).labels, ['NPC', 'NPC']);
  assert.deepEqual(probe([reply('one', clerk('My name is Rook.', 'unknown') + '\n\n' + clerk('Welcome.', 'unknown'))]).labels, ['NPC', 'NPC']);
  const conflict = clerk('Call me Rook.') + '\n\n' + clerk('My name is Vale.') + '\n\n' + clerk('Welcome.');
  assert.deepEqual(probe([reply('one', conflict)]).labels, ['NPC', 'Rook', 'NPC']);
  assert.deepEqual(probe([reply('one', clerk('They said my name is Rook.') + '\n\n' + clerk('Welcome.'))]).labels, ['NPC', 'NPC']);
});

test("undisclosed named speaker metadata stays generic and defined characters remain unchanged", () => {
  const messages = [reply('one', '[SPEAKER:Rook:normal] "Welcome."\n\n[SPEAKER:Maeve:happy] "Hello."')];
  assert.deepEqual(probe(messages, 0, undefined, { entries: [{ name: 'Maeve', role: 'character' }] }).labels, ['NPC', 'Maeve']);
});

test("rows without eligible NPCs do not inspect historical dialogue", () => {
  const previous = { id: 'old', role: 'assistant', get content(): string { throw new Error('Historical prose should stay lazy'); } };
  assert.doesNotThrow(() => {
    const result = probe([previous, reply('one', '[SPEAKER:Maeve:happy] "Hello."')], 1, undefined, { entries: [{ name: 'Maeve', role: 'character' }], skipSpriteProbe: true });
    assert.deepEqual(result.labels, ['Maeve']);
  });
});

test("the VN stage and log display an earned alias without relabeling its introduction", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const api = { sessionId: 'npc-label-ui', worldId: 'world', worldName: 'Academy', entries: [], variables: {}, readOnly: true, isStreaming: false,
    messages: [reply('one', clerk('My name is Rook.') + '\n\n' + clerk('Welcome.'))],
    storage: { get: async () => null, set: async () => {} }, renderMarkdown: (value: string) => value, resolveAssetUrl: (value: string) => value };
  const result = bundleAndCompile({ files, entryFile: 'index.tsx' }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root')!, root = createRoot(container);
  const click = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button, label); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(result.Component!)));
    assert.equal(container.querySelector('.vn-dialogue .vn-name')!.textContent, 'NPC');
    await click('Advance story');
    assert.equal(container.querySelector('.vn-dialogue .vn-name')!.textContent, 'Rook');
    await click('Log');
    assert.deepEqual(Array.from(container.querySelectorAll('.vn-log-row .vn-speaker-name')).map(node => node.textContent), ['NPC', 'Rook']);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
