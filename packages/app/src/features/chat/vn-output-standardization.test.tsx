import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = new URL("../../../../../interfaces/vn/", import.meta.url);
const files = Object.fromEntries(readdirSync(source).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(new URL(name, source), "utf8")]));
const entries = [{ name: "Maeve", role: "character", enabled: true, portrait: "maeve.png" }, { name: "Kei", role: "character", enabled: true, portrait: "kei.png" }];
function render(content: string) {
  const probe = 'import { passages, messageChoices } from "./passages"; export default function Probe(){ const api=useYumina(); return <pre>{JSON.stringify({passages:passages(api.entries,api.content),choices:messageChoices({role:"assistant",content:api.content})})}</pre>; }';
  const result = bundleAndCompile({ files: { ...files, "probe.tsx": probe }, entryFile: "probe.tsx" }, () => ({ entries, content }));
  assert.equal(result.error, null);
  const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
  try { return JSON.parse(dom.window.document.querySelector("pre")!.textContent!); }
  finally { dom.window.close(); }
}

test("nested emphasis in a quoted narrator action cannot swallow the next speaker", () => {
  for (const marker of ["*", "**", "_", "__"]) {
    const result = render(`[SPEAKER:Narrator:normal]${marker}The note says "A candidate who *enjoys* it wins."${marker}\n[SPEAKER:Maeve:smug]"Hello."`);
    assert.equal(result.passages.some((passage: any) => /\[SPEAKER:/.test(passage.text)), false);
    assert.ok(result.passages.some((passage: any) => passage.kind === "narration" && passage.text.includes("A candidate who *enjoys* it wins.")));
    assert.ok(result.passages.some((passage: any) => passage.name === "Maeve" && passage.emotion === "smug" && passage.text === "Hello."));
  }
});

test("repeated simple speaker headers switch the actual character", () => {
  const result = render('[speaker:Maeve] "Hello."\n[speaker:Kei] "Wait."');
  assert.deepEqual(result.passages.map((passage: any) => [passage.name, passage.text]), [["Maeve", "Hello."], ["Kei", "Wait."]]);
});

test("escaped and indented markers stay literal and unfinished actions stop at the next speaker", () => {
  for (const literal of ['\\[SPEAKER:Kei:happy] "literal"', '    [SPEAKER:Kei:happy] "literal"']) {
    const result = render(literal);
    assert.equal(result.passages.some((passage: any) => passage.name === "Kei"), false);
  }
  const result = render('*Maeve nods. "Hello."\n[SPEAKER:Kei:normal] "Wait."');
  assert.ok(result.passages.some((passage: any) => passage.name === "Kei" && passage.text === "Wait."));
  assert.equal(result.passages.some((passage: any) => passage.text.startsWith("*")), false);
  const quote = render('[SPEAKER:Maeve:happy] "Unclosed quote.\n[SPEAKER:Kei:normal] "Wait."');
  assert.ok(quote.passages.some((passage: any) => passage.name === "Kei" && passage.text === "Wait."));
});

test("literal choice and state examples are kept while genuine choices are extracted", () => {
  const literal = '```text\n[CHOICES:["Example A","Example B"]]\n[game-state]\nhp: 10\n[/game-state]\n```';
  const result = render(`${literal}\n[CHOICES:["Ask Maeve","Wait"]]`);
  assert.deepEqual(result.choices, ["Ask Maeve", "Wait"]);
  assert.ok(result.passages.map((passage: any) => passage.text).join("\n").includes('[CHOICES:["Example A","Example B"]]'));
  assert.ok(result.passages.map((passage: any) => passage.text).join("\n").includes('hp: 10'));
  const nested = '[Guide [CHOICES:["A","B"]]](https://example.com)';
  assert.equal(render(nested).passages.map((passage: any) => passage.text).join(""), nested);
});
