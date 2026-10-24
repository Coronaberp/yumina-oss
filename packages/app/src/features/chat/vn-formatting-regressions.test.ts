import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradePersonaRoot } from "../../../../engine/src/world/persona-runtime-upgrade";
import { formattingUpgradeBases } from "../../../../engine/src/world/formatting-upgrade-bases.generated";
import type { RootComponent } from "@yumina/engine";

const source = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(source).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, source), "utf8")]));
const entries = [
  { name: "Mei Amery", role: "character", enabled: true, portrait: null },
  { name: "Black Garden", role: "character", enabled: true, portrait: null },
];
type Passage = { kind: string; name: string; text: string; emotion: string; spriteType?: string };
function inspect(content: string, sources = files): Passage[] {
  const probe = 'import { passages } from "./passages"; export default function Probe(){const api=useYumina();return <pre>{JSON.stringify(passages(api.entries,api.content))}</pre>}';
  const result = bundleAndCompile({ files: { ...sources, "probe.tsx": probe }, entryFile: "probe.tsx" }, () => ({ entries, content }));
  assert.equal(result.error, null, result.error ?? undefined);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
    try { return JSON.parse(dom.window.document.querySelector("pre")!.textContent!); }
    finally { dom.window.close(); }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "React", descriptor);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

test("VN ignores standalone scene dividers without losing story text or literal examples", () => {
  for (const divider of ["---", "-----", "***", "___", "- - -", "* * *", "_ _ _"]) {
    const lines = inspect(`*The first scene ends.*\r\n\r\n${divider}\r\n\r\n*The next scene begins.*`);
    assert.deepEqual(lines.map(line => [line.kind, line.text]), [["narration", "The first scene ends."], ["narration", "The next scene begins."]], divider);
  }
  const literal = inspect('The engine---still humming.\n\n`-----`\n\n```text\n-----\n***\n```');
  const joined = literal.map(line => line.text).join("\n");
  assert.ok(joined.includes("engine---still humming."));
  assert.ok(joined.includes("`-----`"));
  assert.ok(joined.includes("```text\n-----\n***\n```"));
});

test("VN bounds nested bold narration and removes padded action markers before paging", () => {
  const content = '[SPEAKER:Narrator:normal]\n***"Unique"** Code Holders stand at the top. Beneath them are the **"Basic"** holders. At Automata Academy this divide is war beneath the war.*\n\n*And today… Aelorian Myrren steps into it.*\n\n-----\n\n*The transport hums softly.*\n\n* A voice crackles over the intercom:*\n\n[SPEAKER:NPC:normal]\n**"Arrival in thirty seconds."**';
  const lines = inspect(content);
  assert.deepEqual(lines.map(line => [line.kind, line.name, line.text]), [
    ["narration", "", '**"Unique"** Code Holders stand at the top. Beneath them are the **"Basic"** holders. At Automata Academy this divide is war beneath the war.'],
    ["narration", "", "And today… Aelorian Myrren steps into it."],
    ["narration", "", "The transport hums softly."],
    ["narration", "", "A voice crackles over the intercom:"],
    ["dialogue", "NPC", "Arrival in thirty seconds."],
  ]);
});

test("VN separates explicit italic attributions inside Mei's wrapped dialogue", () => {
  const lines = inspect('[SPEAKER:Mei Amery:shy:uniform]\n“Nervous? *Mei says softly* To be honest…so am I. I’m Mei. Mei Amery. *Mei says softly.* Let’s both pray. *Mei says jokingly.*”');
  assert.deepEqual(lines.map(line => [line.kind, line.name, line.text]), [
    ["dialogue", "Mei Amery", "Nervous?"],
    ["narration", "", "Mei says softly"],
    ["dialogue", "Mei Amery", "To be honest…so am I. I’m Mei. Mei Amery."],
    ["narration", "", "Mei says softly."],
    ["dialogue", "Mei Amery", "Let’s both pray."],
    ["narration", "", "Mei says jokingly."],
  ]);
  assert.ok(lines.every(line => line.emotion === "shy" && line.spriteType === "uniform"));
});

test("VN keeps the Black Garden's bold announcements as attributed speech", () => {
  const lines = inspect('[SPEAKER:Black Garden:normal:normal]\n**"CANDIDATE ACKNOWLEDGED."** *Says the Black Garden in its robotic and flat tone.* **"EVALUATING…"**\n\n[SPEAKER:Narrator:normal]\n*There was silence.*\n\n[SPEAKER:Black Garden:normal:normal]\n**"CODE ASSIGNED: UNIQUE-TYPE. STABLE."**');
  assert.deepEqual(lines.filter(line => line.kind === "dialogue").map(line => [line.name, line.text]), [
    ["Black Garden", "CANDIDATE ACKNOWLEDGED."],
    ["Black Garden", "EVALUATING…"],
    ["Black Garden", "CODE ASSIGNED: UNIQUE-TYPE. STABLE."],
  ]);
  assert.ok(lines.some(line => line.kind === "narration" && line.text === "Says the Black Garden in its robotic and flat tone."));
});

test("VN resolves legacy unquoted Mei speech from adjacent explicit attributions", () => {
  const lines = inspect("Nervous? *Mei says softly* So am I. *Mei says jokingly.*\n\n*Soon it was Mei's turn.*\n\nWish me luck~ *Mei says nervously.*");
  assert.deepEqual(lines.filter(line => line.kind === "dialogue").map(line => [line.name, line.text]), [["Mei Amery", "Nervous?"], ["Mei Amery", "So am I."], ["Mei Amery", "Wish me luck~"]]);
  assert.ok(lines.filter(line => line.kind === "narration").every(line => !line.name));
});

test("VN preserves quoted emphasis and narrator descriptions with quoted terms", () => {
  const lines = inspect('[SPEAKER:Mei Amery:normal]\n"I *really* mean it."\n\n[SPEAKER:Narrator:normal]\n*The "Basic" holders wait.*\n\n**The "Unique" holders wait.**');
  assert.deepEqual(lines.map(line => [line.kind, line.text]), [["dialogue", "I really mean it."], ["narration", 'The "Basic" holders wait.'], ["narration", 'The "Unique" holders wait.']]);
});

test("existing saved VN cards receive the formatting fix in memory", () => {
  const saved: Record<string, string> = { ...files,
    "passages.ts": formattingUpgradeBases["passages.ts"]!.at(-1)!,
    "speaker.ts": formattingUpgradeBases["speaker.ts"]!.at(-1)!,
  };
  delete saved["vn-dialogue-spans.ts"];
  const root: RootComponent = { id: "saved-vn", name: "VN", updatedAt: "2026-10-22T00:00:00Z", entryFile: "index.tsx", files: saved, compiled: { code: "old compilation", filesHash: "old", compilerVersion: 1 } };
  const upgraded = upgradePersonaRoot(root);
  assert.notEqual(upgraded, root);
  assert.equal(upgraded.compiled, undefined);
  assert.equal(root.compiled?.code, "old compilation");
  assert.equal(saved["vn-dialogue-spans.ts"], undefined);
  const lines = inspect('[SPEAKER:Black Garden:normal]\n**"CODE ASSIGNED: UNIQUE-TYPE. STABLE."**\n\n-----\n\n[SPEAKER:Narrator:normal]\n*The line moves.*', upgraded.files!);
  assert.deepEqual(lines.map(line => [line.kind, line.name, line.text]), [["dialogue", "Black Garden", "CODE ASSIGNED: UNIQUE-TYPE. STABLE."], ["narration", "", "The line moves."]]);
  assert.equal(upgradePersonaRoot(upgraded), upgraded);
  const custom = { ...root, files: { ...saved, "passages.ts": saved["passages.ts"] + "\n// Authored pagination.\n" } };
  assert.equal(upgradePersonaRoot(custom).files!["passages.ts"], custom.files["passages.ts"]);
});

test("VN quote fragments preserve possessives before an inline attribution", () => {
  const lines = inspect('[SPEAKER:Mei Amery:normal]\n“The teachers’ *Mei says softly* room is here.”');
  assert.deepEqual(lines.map(line => [line.kind, line.text]), [["dialogue", "The teachers’"], ["narration", "Mei says softly"], ["dialogue", "room is here."]]);
});

test("legacy bold speech retains the same named subject as an ordinary quote", () => {
  const lines = inspect('*Mei steps forward.*\n\n**"Hello."**');
  assert.deepEqual(lines.filter(line => line.kind === "dialogue").map(line => [line.name, line.text]), [["Mei Amery", "Hello."]]);
});


test("quoted generic speech emphasis stays inside dialogue", () => {
  for (const text of [
    "Well, *everyone says that*, but I disagree.",
    "I know *people say things* when scared.",
    "*Everyone says that*, but I disagree.",
    "*The teachers say so*, and I agree.",
  ]) {
    const lines = inspect('[SPEAKER:Mei Amery:normal]\n“' + text + '”');
    assert.deepEqual(lines.map(line => [line.kind, line.name, line.text]), [["dialogue", "Mei Amery", text.replaceAll("*", "")]]);
  }
  const attributed = inspect('[SPEAKER:Mei Amery:normal]\n“Hello. *mei says softly* Goodbye.”');
  assert.deepEqual(attributed.map(line => line.kind), ["dialogue", "narration", "dialogue"]);
});
