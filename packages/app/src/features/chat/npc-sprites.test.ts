import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { readVnNpcDefaultSpritePools, writeVnNpcDefaults, writeVnNpcSpritePools } from "../editor/lib/vn-assets";

const directory = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(directory).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(directory + name, "utf8")]));

function probe(expression: string, api: object, spriteSource = files["sprites.ts"]) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const result = bundleAndCompile({ files: { ...files, "sprites.ts": spriteSource, "probe.tsx": `import { passages, messagePassages, segmentPassages } from "./passages"; import { spriteFor, sceneSprites, spriteKey } from "./sprites"; export default function Probe(){ const api=useYumina(); return <pre>{JSON.stringify(${expression})}</pre>; }` }, entryFile: "probe.tsx" }, () => api);
    assert.equal(result.error, null, result.error ?? undefined);
    const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
    const output = JSON.parse(dom.window.document.querySelector("pre")!.textContent!);
    dom.window.close();
    return output;
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

test("NPC gender tags stay hidden, preserve emotion and identity, and never apply to narration or known characters", () => {
  const api = {
    entries: [{ name: "Maeve", role: "character" }],
    text: '[SPEAKER:NPC:happy:male:clerk] "Name?" *The clerk opens a ledger.* [SCENE:hall] "Education?" [SPEAKER:NPC:normal:female:merchant] "Welcome." [SPEAKER:Maeve:shy:female:ignored] "Hello." [SPEAKER:Narrator:normal:male:ignored] *The room is quiet.* [SPEAKER:NPC:normal:unknown:ignored] "Wait."',
  };
  const lines = probe("passages(api.entries, api.text)", api);
  assert.deepEqual(lines.map((line: Record<string, string>) => [line.name, line.kind, line.npcGender, line.npcId]), [
    ["NPC", "dialogue", "male", "clerk"], ["", "narration", undefined, undefined], ["NPC", "dialogue", "male", "clerk"],
    ["NPC", "dialogue", "female", "merchant"], ["Maeve", "dialogue", undefined, undefined], ["", "narration", undefined, undefined], ["NPC", "dialogue", undefined, undefined],
  ]);
  assert.equal(lines[0].emotion, "happy");
  assert.equal(lines[2].scene, "hall");
  assert.ok(lines.every((line: Record<string, string>) => !line.text.includes("SPEAKER:")));
});

test("Default A has one generated figure per gender; disabling it hides NPC defaults and preserves custom art", () => {
  const line = { name: "NPC", npcGender: "male", npcId: "clerk", emotion: "normal" };
  const api = { sessionId: "same-session", variables: {}, line, readLines: [line], resolveAssetUrl: (ref: string) => `/resolved${ref}` };
  const original = files["sprites.ts"];
  const gray = probe("sceneSprites(api,api.readLines,4)", api);
  assert.equal(gray.length, 1); assert.equal(gray[0].defaultMode, "a");
  assert.equal(gray[0].src, "/resolved/vn-assets/npc/default-a/male-dark.png");
  assert.equal(probe("spriteFor(api,api.line)", { ...api, line: { ...line, npcGender: "female" } }), "/resolved/vn-assets/npc/default-a/female-dark.png");
  assert.deepEqual(Object.values(readVnNpcDefaultSpritePools(original, "a")).map(pool => Object.keys(pool).length), [1, 1]);
  const disabled = writeVnNpcDefaults(original, { disabled: true, mode: "a" });
  assert.deepEqual(probe("sceneSprites(api,api.readLines,4)", api, disabled), []);
  const custom = writeVnNpcSpritePools(disabled, { male: { own: "@asset:custom" }, female: {} });
  const selected = probe("sceneSprites(api,api.readLines,4)", api, custom);
  assert.equal(selected[0].src, "/resolved@asset:custom"); assert.equal(selected[0].defaultMode, undefined);
  assert.equal(probe("spriteFor(api,api.line)", api, writeVnNpcDefaults(custom, { disabled: false, mode: "b" })), "/resolved@asset:custom");
  assert.equal(probe("spriteFor(api,api.line)", { ...api, variables: { "vn-npc-sprites": { male: {}, female: {} } } }), null, "explicit empty override remains authoritative");
  const singleGender = original.replace('export const npcSprites = { "male": {}, "female": {} };', 'export const npcSprites = { "female": {} };');
  assert.equal(probe("spriteFor(api,api.line)", api, singleGender), gray[0].src, "missing custom gender still uses the configured defaults");
});

test("player persona expressions render on stage and missing sets use a stable NPC sprite", () => {
  const playerApi = {
    sessionId: "persona-session",
    entries: [],
    user: { name: "Robin", avatar: "portrait.png", sprites: { normal: "robin-normal.png", happy: "robin-happy.png" } },
    variables: {},
    resolveAssetUrl: (ref: string) => `/resolved/${ref}`,
    content: '[SPEAKER:{{user}}:normal] "Ready." [SPEAKER:{{user}}:happy] "Great!"',
  };
  const normal = probe("sceneSprites(api, messagePassages(api, { content: api.content }), 4)", { ...playerApi, content: '[SPEAKER:{{user}}:normal] \"Ready.\"' });
  const happy = probe("sceneSprites(api, messagePassages(api, { content: api.content }), 4)", { ...playerApi, content: '[SPEAKER:{{user}}:happy] \"Great!\"' });
  assert.equal(normal[0].src, "/resolved/robin-normal.png");
  assert.equal(happy[0].src, "/resolved/robin-happy.png");
  assert.equal(normal[0].player, true);
  const segmentApi = { ...playerApi, variables: { segments: [{ speaker: "Robin", emotion: "happy", text: "Great!" }] } };
  assert.equal(probe("sceneSprites(api, segmentPassages(api), 4)", segmentApi)[0].src, "/resolved/robin-happy.png");

  const fallbackApi = { ...playerApi, user: { name: "Robin", avatar: "portrait.png" }, content: '[SPEAKER:{{user}}:normal] "Ready."' };
  const fallback = probe("sceneSprites(api, messagePassages(api, { content: api.content }), 4)", fallbackApi);
  const replay = probe("sceneSprites(api, messagePassages(api, { content: api.content }), 4)", fallbackApi);
  assert.equal(fallback[0].defaultMode, "a");
  assert.match(fallback[0].src, /\/vn-assets\/npc\/default-a\/(male|female)-dark\.png$/);
  assert.equal(fallback[0].src, replay[0].src);
  const disabledDefaults = files["sprites.ts"].replace('export const npcDefaults = { "disabled": false,', 'export const npcDefaults = { "disabled": true,');
  assert.ok(probe("sceneSprites(api, messagePassages(api, { content: api.content }), 4)", fallbackApi, disabledDefaults).length,
    "player fallback remains available when incidental NPC defaults are disabled");
});

test("Default B uses the original 15 sprites per gender and restores the same assignment after disable/re-enable", () => {
  const source = writeVnNpcDefaults(files["sprites.ts"], { disabled: false, mode: "b" });
  const pools = readVnNpcDefaultSpritePools(source, "b");
  assert.deepEqual(Object.values(pools).map(pool => Object.keys(pool).length), [15, 15]);
  const line = { name: "NPC", npcGender: "female", npcId: "merchant", emotion: "normal" };
  const api = { sessionId: "same-session", variables: {}, line, readLines: [line], resolveAssetUrl: (ref: string) => ref };
  const cast = probe("sceneSprites(api,api.readLines,4)", api, source);
  assert.ok(Object.values(pools.female).includes(cast[0].src)); assert.equal(cast[0].defaultMode, "b");
  const disabled = writeVnNpcDefaults(source, { disabled: true, mode: "b" });
  assert.equal(probe("spriteFor(api,api.line)", api, disabled), null);
  assert.deepEqual(probe("sceneSprites(api,api.readLines,4)", api, writeVnNpcDefaults(disabled, { disabled: false, mode: "b" })), cast);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, line: { ...line, emotion: "happy" } }, source), cast[0].src);
});

test("structured NPC segments carry explicit gender and stable identity without guessing", () => {
  const api = { entries: [{ name: "Maeve", role: "character" }], variables: { segments: [
    { speaker: "NPC", gender: "Female", npcId: "Merchant", emotion: "happy", text: "Welcome." },
    { speaker: "Maeve", gender: "male", npcId: "ignored", text: "Hello." },
    { speaker: "Narrator", gender: "male", text: "*The room is quiet.*" },
    { speaker: "Clerk", text: "Name?" },
  ] } };
  const lines = probe("segmentPassages(api)", api);
  assert.deepEqual(lines.map((line: Record<string, string>) => [line.name, line.npcGender, line.npcId]), [
    ["NPC", "female", "merchant"], ["Maeve", undefined, undefined], ["", undefined, undefined], ["NPC", undefined, undefined],
  ]);
});

test("NPC selection uses only matching uploaded pools and stays stable across rerenders, reloads, emotions and pool order", () => {
  const pools = { male: { a: "@asset:male-a", b: "@asset:male-b", c: "@asset:male-c" }, female: { a: "@asset:female-a", b: "@asset:female-b" } };
  const api = { sessionId: "session-one", variables: { "vn-npc-sprites": pools }, resolveAssetUrl: (ref: string) => `/resolved/${ref}`, line: { name: "NPC", npcGender: "male", npcId: "clerk", emotion: "normal" } };
  const selected = probe("spriteFor(api,api.line)", api);
  assert.ok(Object.values(pools.male).some(ref => selected === `/resolved/${ref}`));
  for (let i = 0; i < 3; i++) assert.equal(probe("spriteFor(api,api.line)", { ...api }), selected);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, line: { ...api.line, emotion: "happy" } }), selected);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, variables: { "vn-npc-sprites": { ...pools, male: Object.fromEntries(Object.entries(pools.male).reverse()) } } }), selected);
  const female = probe("spriteFor(api,api.line)", { ...api, line: { ...api.line, npcGender: "female" } });
  assert.ok(Object.values(pools.female).some(ref => female === `/resolved/${ref}`));
  assert.equal(probe("spriteFor(api,api.line)", { ...api, line: { ...api.line, npcGender: "unknown" } }), null);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, variables: { "vn-npc-sprites": { female: pools.female } } }), null);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, variables: { "vn-npc-sprites": "broken json" } }), null);
  assert.equal(probe("spriteFor(api,api.line)", { ...api, line: { ...api.line, name: "Maeve" } }), null);
});

test("NPC cast slots are separate, respect the existing caps and restore the same sprite after scene changes and backward navigation", () => {
  const clerk = { name: "NPC", npcGender: "male", npcId: "clerk", emotion: "normal", scene: "hall" };
  const merchant = { name: "NPC", npcGender: "female", npcId: "merchant", emotion: "normal", scene: "hall" };
  const guard = { name: "NPC", npcGender: "male", npcId: "guard", emotion: "normal", scene: "hall" };
  const pools = { male: { a: "@asset:male-a", b: "@asset:male-b" }, female: { a: "@asset:female-a" } };
  const api = { sessionId: "session-two", variables: { "vn-npc-sprites": JSON.stringify(pools), "vn-sprites": { Maeve: { normal: "@asset:maeve" } } }, resolveAssetUrl: (ref: string) => ref, readLines: [clerk, merchant, guard], limit: 2 };
  const cast = probe("sceneSprites(api,api.readLines,api.limit)", api);
  assert.deepEqual(cast.map((line: Record<string, string>) => line.key), ["npc:female:merchant", "npc:male:guard"]);
  assert.ok(cast.every((line: Record<string, string>) => line.name === "NPC"));
  const initial = probe("sceneSprites(api,[api.readLines[0]],4)", api)[0];
  const returned = probe('sceneSprites(api,[...api.readLines,{name:"",scene:"garden"},{...api.readLines[0],scene:"garden"}],4)', api)[0];
  assert.deepEqual(returned, initial);
  assert.equal(probe("sceneSprites(api,api.readLines,4)", api).length, 3);
  assert.deepEqual(probe('sceneSprites(api,[...api.readLines,{name:"",scene:"garden"}],4)', api), []);
  assert.equal(probe('spriteFor(api,{name:"Maeve",emotion:"normal",npcGender:"male",npcId:"clerk"})', api), "@asset:maeve", "defined character art wins over a fallback");
});
