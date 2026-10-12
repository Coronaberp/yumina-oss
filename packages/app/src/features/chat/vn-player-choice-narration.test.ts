import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradePersonaRoot, type RootComponent } from "@yumina/engine";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]));
function playerLines(text: string) {
  const result = bundleAndCompile({ files: { ...files, "probe.tsx": 'import { playerChoicePassages } from "./passages"; export default function Probe(){const api=useYumina(); return <pre>{JSON.stringify(playerChoicePassages(api.text,{name:"Aelorian Myrren",avatar:"persona.png"},"happy"))}</pre>}' }, entryFile: "probe.tsx" }, () => ({ text }));
  assert.equal(result.error, null);
  const html = renderToStaticMarkup(createElement(result.Component!));
  const plain = html.replace(/^<pre>|<\/pre>$/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(plain) as Array<{text:string;kind:string;name:string;player?:boolean;portrait?:string;emotion:string}>;
}

test("the reported player choice separates the action from the quoted speech", () => {
  const lines = playerLines('Flash a confident grin and place 100 gold coins on the counter. "Is this enough for now?"');
  assert.deepEqual(lines.map(e => [e.kind, e.text]), [["narration", "Flash a confident grin and place 100 gold coins on the counter."], ["dialogue", "Is this enough for now?"]]);
  assert.equal(lines[0]!.name, "");
  assert.equal(lines[1]!.name, "Aelorian Myrren (You)");
  assert.equal(lines[1]!.portrait, "persona.png");
  assert.equal(lines[1]!.emotion, "happy");
});

test("pure player actions remain narration; quote marks and apostrophes preserve speech", () => {
  assert.equal(playerLines("Follow her.")[0]!.kind, "narration");
  assert.equal(playerLines('"I can do this."')[0]!.kind, "dialogue");
  const lines = playerLines('*Touch Sera’s sleeve. “I won’t leave.”');
  assert.deepEqual(lines.map(e => [e.kind, e.text]), [["narration", "Touch Sera’s sleeve."], ["dialogue", "I won’t leave."]]);
});

test("long player actions produce bounded pages before their spoken answer", () => {
  const lines = playerLines("Examine the gold coin carefully. ".repeat(25) + '"I agree."');
  assert.ok(lines.length > 3);
  assert.ok(lines.every(e => e.text.length <= 280));
  assert.equal(lines.at(-1)!.kind, "dialogue");
  assert.equal(lines.at(-1)!.text, "I agree.");
});

test("recognizable saved VN cards receive the player narration helper without overwriting authored files", () => {
  const oldLine = '  const pendingPlayerLine = pendingPlayerSprite ? { name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression, text: pendingPlayerSprite.text } : null;';
  const index = 'import { passages, messagePassages, segmentPassages, messageChoices } from "./passages";\nfunction Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {}\n' + oldLine + '\n  const lines = pendingPlayerLine ? [pendingPlayerLine] : replyLines;\n  const index = Math.max(0, Math.min(pendingPlayerLine ? 0 : cursor.turn === turn ? cursor.index : 0, lines.length - 1));';
  const oldPassages = files['passages.ts']!.replace(/\/\*\* A submitted choice[\s\S]*?(?=\nexport function messageChoices)/, '');
  const original = { id: "old", entryFile: "index.tsx", files: { ...files, "index.tsx": index, "passages.ts": oldPassages, "authored.ts": "export const authored = 42;" }, compiled: { code: "cached" } } as unknown as RootComponent;
  const next = upgradePersonaRoot(original);
  assert.match(next.files['index.tsx']!, /playerChoicePassages\(pendingPlayerSprite.text/);
  assert.match(next.files['passages.ts']!, /export function playerChoicePassages/);
  assert.equal(next.files['authored.ts'], "export const authored = 42;");
  assert.equal(next.compiled, undefined);
  assert.equal(original.files['index.tsx'], index);
  assert.deepEqual(upgradePersonaRoot(next), next);
});


test("a customized saved passage parser without helper dependencies remains intact", () => {
  const index = 'import { playerText } from "./player";\nfunction Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {}\n  const pendingPlayerLine = pendingPlayerSprite ? { name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression, text: pendingPlayerSprite.text } : null;';
  const original = { id: "custom", entryFile: "index.tsx", files: { "index.tsx": index, "passages.ts": "export function messagePassages(api, message) { return api.myParser(message); }" } } as unknown as RootComponent;
  const next = upgradePersonaRoot(original);
  assert.equal(next.files['index.tsx'], index);
  assert.equal(next.files['passages.ts'], original.files['passages.ts']);
});
