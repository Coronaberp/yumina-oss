import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(source + name, "utf8")]));
const ryu = { name: "Ryu (Ryutharax)", role: "character", portrait: "/ryu.png" };
const evelia = { name: "Evelia", role: "character", portrait: "/evelia.png" };
type Passage = { name: string; portrait: string | null; kind: string; text: string };
type Character = { name: string; role: string; portrait: string | null; enabled?: boolean };

function inspect(text: string, entries: Character[] = [ryu, evelia]): Passage[] {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
  try {
    const probe = bundleAndCompile({ files: { ...files, "probe.tsx": 'import { passages } from "./passages"; export default function Probe(){const api=useYumina();return <pre>{JSON.stringify(passages(api.entries,api.testText))}</pre>}' }, entryFile: "probe.tsx" }, () => ({ entries, testText: text }));
    assert.equal(probe.error, null, probe.error ?? undefined);
    const dom = new JSDOM(renderToStaticMarkup(createElement(probe.Component!)));
    try { return JSON.parse(dom.window.document.querySelector("pre")!.textContent!); }
    finally { dom.window.close(); }
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

test("legacy Ryu dialogue follows reached actions and commanded attributions", () => {
  const text = `*Ryu reached down to conjure a containment sphere. The sphere lifted off the ground.*

"I should dissolve you for parts." *Ryu's eyes narrowed, her vertical pupils contracting to thin slits.* "Or perhaps I will simply keep you as a reminder."

*Ryu turned sharply, the sphere following in her wake.*

*The corridor beyond stretched long and cold. Ryu felt their painted eyes mocking her.*

"Do not drip on my floor," *Ryu commanded the slime, though she had no expectation it could understand.* "You will remain perfectly still and silent."`;
  const passages = inspect(text);
  assert.deepEqual(passages.filter(p => p.kind === "dialogue").map(p => [p.name, p.portrait]), Array.from({ length: 4 }, () => [ryu.name, ryu.portrait]));
  assert.ok(passages.filter(p => p.kind === "narration").every(p => p.name === "" && p.portrait === null));
});

test("reach forms resolve a unique named actor while unknown and ambiguous speakers stay NPC", () => {
  for (const action of ["reach", "reaches", "reached"]) {
    assert.equal(inspect(`*Ryu ${action} down.*\n\n"Wait."`).find(p => p.kind === "dialogue")!.name, ryu.name);
  }
  for (const speech of ["command", "commands", "commanded"]) {
    assert.equal(inspect(`"Wait," *Ryu ${speech}.*`).find(p => p.kind === "dialogue")!.name, ryu.name);
    assert.equal(inspect(`"Wait," *Unknown ${speech}.*`).find(p => p.kind === "dialogue")!.name, "NPC");
  }
  const collision = { ...ryu, name: "Ryu (Another)" };
  assert.equal(inspect('"Wait," *Ryu commanded.*', [ryu, evelia, collision]).find(p => p.kind === "dialogue")!.name, "NPC");
  assert.equal(inspect('*Ryu reached for Evelia.* "Wait."').find(p => p.kind === "dialogue")!.name, "NPC");
  assert.equal(inspect('*Ryu reached down.*\n\n*The guard enters.*\n\n"Wait."').find(p => p.kind === "dialogue")!.name, "NPC");
});

test("legacy attribution works for other characters, unique aliases and arbitrary names", () => {
  for (const [name, alias] of [["Sera (Seraphine)", "Seraphine"], ["Lilith Vexthorne", "Lilith"], ["Diane Bluerose", "Diane"], ["阿璃 (Ari)", "阿璃"], ["A+B Scholar", "A+B"], ["Anne-Marie", "Anne-Marie"], ["O'Connor", "O'Connor"]]) {
    const character = { name, role: "character", portrait: "/other-character.png" };
    for (const identifier of [name, alias]) {
      for (const text of [`*${identifier} reached down.*\n\n"Wait."`, `"Wait," *${identifier} commanded.*`, `"Wait," commanded ${identifier}.`]) {
        const dialogue = inspect(text, [ryu, character]).filter(p => p.kind === "dialogue");
        assert.deepEqual(dialogue.map(p => [p.name, p.portrait]), [[name, character.portrait]], text);
      }
    }
  }
  const scholar = { name: "A+B Scholar", role: "character", portrait: "/scholar.png" };
  assert.equal(inspect('*A+B reached down while Unknown reached up.* "Wait."', [ryu, scholar]).find(p => p.kind === "dialogue")!.name, "NPC");
  assert.equal(inspect('*A+Bob reached down.* "Wait."', [ryu, scholar]).find(p => p.kind === "dialogue")!.name, "NPC");
});

test("speaker switches resolve independently and explicit VN tags retain priority", () => {
  const diane = { name: "Diane Bluerose", role: "character", portrait: null };
  const entries = [ryu, evelia, diane];
  const text = '*Ryu reached down.*\n\n"One."\n\n"Two," *Evelia commanded.*\n\n*Diane reached for the door.*\n\n"Three."\n\n"Four," *Unknown commanded.*';
  assert.deepEqual(inspect(text, entries).filter(p => p.kind === "dialogue").map(p => [p.name, p.portrait]), [[ryu.name, ryu.portrait], [evelia.name, evelia.portrait], [diane.name, null], ["NPC", null]]);
  const pinned = inspect('[SPEAKER:Evelia:normal] "Wait," *Ryu commanded.*', entries);
  assert.equal(pinned.find(p => p.kind === "dialogue")!.name, evelia.name);
  assert.equal(inspect('"Wait," *Diane commanded.*', [ryu, { ...diane, enabled: false }]).find(p => p.kind === "dialogue")!.name, "NPC");
});

test("invisible padding in generated VN markers still resolves speakers and hides metadata", () => {
  const sera = { name: "Sera (Seraphine)", role: "character", portrait: "/sera.png" };
  for (const padding of ["\u200B", "\u2060"]) {
    const text = `[SCENE:training-yard]\n[${padding}SPEAKER:Narrator:normal]*The lesson begins.*\n[${padding}SPEAKER:Sera:smug]"Hello."\n[${padding}SPEAKER:Narrator:normal]*Sera turns away.*`;
    const passages = inspect(text, [ryu, sera]);
    assert.deepEqual(passages.map(p => [p.kind, p.name, p.portrait, p.text]), [
      ["narration", "", null, "The lesson begins."],
      ["dialogue", sera.name, sera.portrait, "Hello."],
      ["narration", "", null, "Sera turns away."],
    ]);
  }
});

test("quoted and code markers remain literal after removing zero-width spaces", () => {
  const sera = { name: "Sera (Seraphine)", role: "character", portrait: "/sera.png" };
  const marker = "[\u200BSPEAKER:Ryu:angry]";
  const text = `[SPEAKER:Sera:normal] "The marker is ${marker}."\n\n\`${marker}\``;
  const passages = inspect(text, [ryu, sera]);
  assert.equal(passages.find(p => p.kind === "dialogue")!.name, sera.name);
  assert.ok(passages.filter(p => p.text.includes(marker.replace(/\u200B/g, ""))).length === 2, "quoted and code examples stay literal");
  assert.ok(passages.every(p => !p.text.includes("\u200B")));
});

test("player-template possessives do not swallow speaker and scene markers", () => {
  for (const apostrophe of ["'", "‘", "’"]) {
    const text = `[SPEAKER:NPC:normal:male:academy-clerk]\n"Name?"\n\n{{user}}${apostrophe}s silver-blue eyes held steady. The seal of the Adventurers${apostrophe} Guild caught the light.\n\n[SPEAKER:NPC:normal:male:academy-clerk]\n"Rank F."\n\n[SPEAKER:Narrator:normal]\n*The clerk returns the documents.*\n[SCENE: courtyard]\n*The courtyard swells with students.*`;
    const lines = inspect(text);
    assert.deepEqual(lines.filter(p => p.kind === "dialogue").map(p => p.text), ["Name?", "Rank F."]);
    assert.ok(lines.some(p => p.kind === "narration" && p.text.includes(`{{user}}${apostrophe}s silver-blue eyes`)));
    assert.ok(lines.every(p => !/\[(?:SPEAKER|SCENE):/i.test(p.text)));
    assert.equal((lines.at(-1) as Passage & { scene: string }).scene, "courtyard");
  }
});

test("narration between quoted passages does not inherit a marked NPC speaker", () => {
  const text = '[SPEAKER:NPC:normal:male:academy-clerk]\n"Rank F." He adjusted his spectacles. "You are fresh, then."\n\nA gilded noble further down the line craned his neck.\n[SPEAKER:Narrator:normal]\n*The line moves.*';
  const lines = inspect(text);
  assert.deepEqual(lines.filter(p => p.kind === "dialogue").map(p => p.text), ["Rank F.", "You are fresh, then."]);
  assert.ok(lines.some(p => p.kind === "narration" && p.text === "He adjusted his spectacles."));
  assert.ok(lines.some(p => p.kind === "narration" && p.text === "A gilded noble further down the line craned his neck."));
  assert.deepEqual(inspect('[SPEAKER:NPC:normal] Welcome.').map(p => [p.kind, p.text]), [["dialogue", "Welcome."]]);
  assert.deepEqual(inspect('[SPEAKER:Ryu:normal] "Yes."\n\nEvelia: Fine.').filter(p => p.kind === "dialogue").map(p => [p.name, p.text]), [[ryu.name, "Yes."], [evelia.name, "Fine."]]);
});

test("curly quotation marks still delimit genuine speech and preserve marker examples", () => {
  const lines = inspect('[SPEAKER:Ryu:normal] ‘The literal [SCENE: courtyard] stays in my words.’\n[SPEAKER:Narrator:normal]\n*Ryu leaves.*');
  assert.deepEqual(lines.filter(p => p.kind === "dialogue").map(p => [p.name, p.text]), [[ryu.name, "The literal [SCENE: courtyard] stays in my words."]]);
  assert.deepEqual(lines.at(-1)?.text, "Ryu leaves.");
});
