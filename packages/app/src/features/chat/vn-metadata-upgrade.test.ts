import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import React, { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradeVnMetadataFiles } from "./vn-metadata-upgrade";

// Exact passages and snapshot-only metadata from the older Magic Academy COPY card.
const oldPassages = "import { splitSpeakerSections } from \"./speaker\";\nimport { displayCharacterName, canonicalCharacterName, parseLeadingSpeakerTag } from \"./speaker-tag\";\nimport { dialogueSpans, plainDialogue } from \"./dialogue-spans\";\nimport { extractResponseChoices, normalizeChoices } from \"./choices\";\nimport { stripGameStateDump } from \"./metadata\";\nimport { normalizeSpriteExpression, normalizeSpriteId, normalizeSpriteSelectionId } from \"./expressions\";\nimport { stripZeroWidthSpaces } from \"./text-normalization\";\nimport { standardizeSpeakerMarkup } from \"./presentation-markup\";\n\nfunction character(entries, name) {\n  const characters = (entries || []).filter(e => e.role === \"character\" && e.enabled !== false);\n  const canonical = canonicalCharacterName(characters.map(e => displayCharacterName(e.name)), displayCharacterName(name));\n  return characters.find(e => displayCharacterName(e.name) === canonical);\n}\n\nfunction pages(text) {\n  const result = [];\n  while (text.length > 280) {\n    const prefix = text.slice(0, 280);\n    const sentence = [...prefix.matchAll(/[.!?\u3002\uff01\uff1f](?:[\u201d\u2019\"])?\\s+/g)].at(-1);\n    const split = sentence && sentence.index > 100 ? sentence.index + sentence[0].length : prefix.lastIndexOf(\" \");\n    if (split <= 0) break;\n    result.push(text.slice(0, split).trim()); text = text.slice(split).trim();\n  }\n  if (text) result.push(text);\n  return result;\n}\n\n/** Explicit VN markers carry the speaker/expression until the next marker.\n * Actions always produce their own narrator passage. Legacy labels still work. */\nexport function passages(entries, content, rawContent = content, player = null) {\n  if (!content) return [];\n  const names = (entries || []).filter(entry => entry.role === \"character\" && entry.enabled !== false).map(entry => displayCharacterName(entry.name));\n  content = standardizeSpeakerMarkup(stripZeroWidthSpaces(content), names);\n  rawContent = standardizeSpeakerMarkup(stripZeroWidthSpaces(rawContent), names);\n  content = stripGameStateDump(extractResponseChoices(content).text);\n  const legacy = parseLeadingSpeakerTag(rawContent);\n  content = parseLeadingSpeakerTag(content).text;\n  const leading = /^\\s*\\[\\s*(?:SPEAKER|Name)\\s*:\\s*([^:\\]\\n]+)\\s*:\\s*([^\\]\\n]+)\\]/i.exec(rawContent);\n  const initialFields = leading?.[2]?.split(\":\").map(field => field.trim()) || [];\n  let name = legacy.speaker || leading?.[1]?.trim() || \"\", emotion = normalizeSpriteId(initialFields[0]), scene = \"\", offset = 0, explicit = !!leading,\n    npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(initialFields[1] || \"\") ? initialFields[1].toLowerCase() : \"\";\n  let spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" && initialFields[1] ? normalizeSpriteId(initialFields[1]) : undefined;\n  let spriteVariant = spriteType && initialFields[2] ? normalizeSpriteId(initialFields[2]) : undefined;\n  let npcId = npcGender ? initialFields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n  const chunks = [];\n  const literals = dialogueSpans(content).filter(span => span.kind === \"literal\" || span.kind === \"dialogue\");\n  const opaque = [...content.matchAll(/!?\\[[^\\]\\n]*\\]\\([^()\\n]*\\)|<[^>\\n]*>/g)];\n  // Some providers emit an invisible separator before the marker keyword.\n  // Accept it as padding without changing names, prose, quotes or code.\n  const marker = /\\[[\\s\\u200B\\u2060]*(SPEAKER|Name)\\s*:\\s*([^:\\]\\n]+)\\s*:\\s*([^\\]\\n]+)\\]|\\[[\\s\\u200B\\u2060]*SCENE\\s*:\\s*([^\\]\\n]+)\\]/gi;\n  for (const match of content.matchAll(marker)) {\n    if (literals.some(span => match.index >= span.end - span.text.length && match.index < span.end)) continue;\n    if (opaque.some(span => match.index >= span.index && match.index < span.index + span[0].length)) continue;\n    chunks.push({ text: content.slice(offset, match.index), name, emotion, spriteType, spriteVariant, scene, explicit, npcGender, npcId });\n    if (match[4]) scene = match[4].trim();\n    else {\n      name = match[2].trim();\n      const fields = match[3].split(\":\").map(field => field.trim());\n      emotion = normalizeSpriteId(fields[0]); explicit = true;\n      spriteType = name.toLowerCase() !== \"npc\" && name.toLowerCase() !== \"narrator\" && fields[1] ? normalizeSpriteId(fields[1]) : undefined;\n      spriteVariant = spriteType && fields[2] ? normalizeSpriteId(fields[2]) : undefined;\n      npcGender = name.toLowerCase() === \"npc\" && /^(male|female)$/i.test(fields[1] || \"\") ? fields[1].toLowerCase() : \"\";\n      npcId = npcGender ? fields.slice(2).join(\":\").toLowerCase() || \"unknown\" : \"\";\n    }\n    offset = match.index + match[0].length;\n  }\n  chunks.push({ text: content.slice(offset), name, emotion, spriteType, spriteVariant, scene, explicit, npcGender, npcId });\n  const playerSpeaker = name => /^(?:\\{\\{user\\}\\}|you|user|player)$/i.test(name || \"\") || !!player?.name && String(name).toLocaleLowerCase() === player.name.toLocaleLowerCase() && !character(entries, name);\n  return chunks.flatMap(chunk => {\n    const declared = character(entries, chunk.name);\n    const known = declared || (playerSpeaker(chunk.name) ? { name: chunk.name, role: \"character\", enabled: true, portrait: player?.avatar || null } : null);\n    // An explicit marker can identify an incidental NPC without a stored\n    // character entry. Register it only for this marked passage.\n    const explicitSpeaker = chunk.explicit && chunk.name.toLowerCase() !== \"narrator\"\n      ? { name: chunk.name, role: \"character\", enabled: true, portrait: null } : null;\n    const tagged = known || explicitSpeaker;\n    const speakerEntries = known && !declared ? [...(entries || []), known] : !known && explicitSpeaker ? [...(entries || []), explicitSpeaker] : entries;\n    const tag = chunk.name ? `[speaker: ${tagged ? displayCharacterName(tagged.name) : \"narrator\"}]` : \"\";\n    const chunkHasQuotes = dialogueSpans(chunk.text).some(span => span.kind === \"dialogue\");\n    return splitSpeakerSections(speakerEntries, chunk.text, tag + chunk.text, chunk.explicit).flatMap(section => {\n      const spans = dialogueSpans(section.content);\n      const hasQuotes = spans.some(span => span.kind === \"dialogue\");\n      return spans.flatMap(span => {\n        let text = span.text.trim();\n        if (!text) return [];\n        const narratorLabel = /^\\s*(?:\\*{1,2}|_{1,2})?Narrator(?:\\*{1,2}|_{1,2})?\\s*:/i.test(section.text) ||\n          (chunk.explicit && chunk.name.toLowerCase() === \"narrator\" && !section.speaker);\n        const spoken = !narratorLabel && (span.kind === \"dialogue\" || (span.kind === \"text\" && !hasQuotes && !!(section.speaker || (!chunkHasQuotes && chunk.explicit && tagged))));\n        const speaker = spoken ? section.speaker || tagged : null;\n        if (span.kind === \"dialogue\") text = plainDialogue(text).replace(/^([\"'\u201c\u2018\u00ab\u300c\u300e])([\\s\\S]*?)[\"'\u201d\u2019\u00bb\u300d\u300f]$/, \"$2\");\n        if (span.kind === \"action\") text = text.replace(/^(\\*{1,3}|_{1,3})([\\s\\S]*?)\\1$/, \"$2\");\n        const kind = spoken ? \"dialogue\" : \"narration\";\n        const isPlayer = spoken && !!speaker && playerSpeaker(speaker.name);\n        const definedSpeaker = spoken && speaker && !isPlayer ? character(entries, speaker.name) : null;\n        return pages(text).map(text => ({ name: isPlayer ? player?.name ? `${player.name} (You)` : \"You\" : spoken ? definedSpeaker ? displayCharacterName(definedSpeaker.name) : \"NPC\" : \"\", portrait: isPlayer ? player?.avatar || null : definedSpeaker?.portrait || null,\n          ...(isPlayer ? { player: true } : {}),\n          ...(!spoken && declared && chunk.explicit && span.kind !== \"literal\" ? { stageName: displayCharacterName(declared.name) } : {}),\n          emotion: chunk.emotion, spriteType: chunk.spriteType, spriteVariant: chunk.spriteVariant, scene: chunk.scene, kind, text,\n          ...(spoken && !definedSpeaker && chunk.npcGender ? { npcGender: chunk.npcGender, npcId: chunk.npcId } : {}) }));\n      });\n    });\n  });\n}\n\nexport function messagePassages(api, message) {\n  const swipe = message.swipes?.[message.activeSwipeIndex || 0];\n  return passages(api.entries, message.content || \"\", swipe?.rawContent || message.content, api.user);\n}\n\nexport function messageChoices(message) {\n  if (!message || message.role !== \"assistant\") return [];\n  const swipe = message.swipes?.[message.activeSwipeIndex || 0];\n  const choices = normalizeChoices(swipe?.choices);\n  if (choices?.length) return choices;\n  for (const text of [swipe?.rawContent, swipe?.content, message.content]) {\n    const parsed = extractResponseChoices(text || \"\").choices;\n    if (parsed !== undefined) return parsed;\n  }\n  return [];\n}\n\nexport function segmentPassages(api) {\n  try {\n    const raw = api.variables?.segments;\n    const segments = typeof raw === \"string\" ? JSON.parse(raw) : raw;\n    if (!Array.isArray(segments)) return [];\n    return segments.flatMap(segment => {\n      if (!segment || typeof segment.text !== \"string\") return [];\n      const speaker = typeof segment.speaker === \"string\" ? segment.speaker.trim() : \"\";\n      const entry = character(api.entries, speaker);\n      const isPlayer = /^(?:\\{\\{user\\}\\}|you|user|player)$/i.test(speaker) || !!api.user?.name && speaker.toLocaleLowerCase() === api.user.name.toLocaleLowerCase() && !entry;\n      const name = isPlayer ? \"{{user}}\" : entry ? displayCharacterName(entry.name) : speaker && speaker.toLowerCase() !== \"narrator\" ? \"NPC\" : \"Narrator\";\n      const gender = typeof segment.gender === \"string\" && /^(male|female)$/i.test(segment.gender.trim()) ? segment.gender.trim().toLowerCase() : \"\";\n      const id = typeof segment.npcId === \"string\" ? segment.npcId.replace(/[\\]\\r\\n]/g, \"\").trim() : \"unknown\";\n      const metadata = !entry && name === \"NPC\" && gender ? `:${gender}:${id || \"unknown\"}` : \"\";\n      const typeId = normalizeSpriteSelectionId(segment.spriteType);\n      const variantId = segment.spriteVariant == null || segment.spriteVariant === \"\" ? \"\" : normalizeSpriteSelectionId(segment.spriteVariant);\n      const spriteType = name !== \"NPC\" && name !== \"Narrator\" && typeId && variantId !== undefined\n        ? `:${typeId}${variantId ? `:${variantId}` : \"\"}` : \"\";\n      const markup = `[SPEAKER:${name}:${normalizeSpriteId(segment.emotion)}${metadata || spriteType}] ${segment.text}`;\n      return passages(api.entries, markup, markup, api.user);\n    });\n  } catch { return []; }\n}\n";
const oldMetadata = "import { maskPresentationLiterals } from \"./presentation-literals\";\n\n/** Hide model-emitted state snapshots from prose without interpreting them as writes. */\nexport function stripGameStateDump(text: string): string {\n  const literals = maskPresentationLiterals(text);\n  // Models sometimes mix a bracket opener with an XML closer. Both are\n  // reserved metadata wrappers; the original response remains available as raw.\n  return literals.restore(literals.text.replace(\n    /^[\\t ]*(?:\\[\\s*game[-_]state\\s*\\]|<game[-_]state\\s*>)[\\t ]*\\r?\\n[\\s\\S]*?^[\\t ]*(?:\\[\\s*\\/game[-_]state\\s*\\]|<\\/game[-_]state\\s*>)[\\t ]*$/gim,\n    \"\",\n  ));\n}\n";
const directory = new URL("../../../../../interfaces/vn/", import.meta.url);
const current = Object.fromEntries(readdirSync(directory).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, directory), "utf8")]));
const angle = current["angle-markup.ts"];
const oldFiles = () => ({ ...current, "passages.ts": oldPassages, "metadata.ts": oldMetadata });

test("the actual older snapshot-only card modules mount without injecting an unavailable metadata helper", async () => {
  const files = oldFiles();
  const next = upgradeVnMetadataFiles(files, angle);
  assert.equal(next["metadata.ts"], oldMetadata, "authored snapshot filtering is retained");
  assert.deepEqual(inspectMetadata(mixedSnapshot('[game-state]', '</game-state>'), next).lines.map(line => [line.kind, line.text]), [["dialogue", "Enrolled."], ["narration", "The clerk returns to his desk."]]);
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const content = '<aside>[SPEAKER:NPC:normal] "The old card stays readable."</aside>';
  const api = { sessionId: "metadata-regression", worldId: "fixture", worldName: "Fixture", variables: {}, entries: [], messages: [{ id: "reply", role: "assistant", content }], pendingChoices: [], isStreaming: false, readOnly: true, error: null, storage: { get: async () => null, set: async () => {} }, renderMarkdown: (text: string) => text, resolveAssetUrl: (asset: string) => asset };
  try {
    const compiled = bundleAndCompile({ files: next, entryFile: "index.tsx" }, () => api);
    assert.equal(compiled.error, null);
    await act(async () => root.render(createElement(compiled.Component!)));
    assert.equal(dom.window.document.querySelector(".vn-text")?.textContent, "The old card stays readable.");
    assert.equal(upgradeVnMetadataFiles(next, angle), next);
    assert.equal(files["passages.ts"], oldPassages);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("a stock metadata helper receives its matching import with both passage transforms atomically", () => {
  for (const existingAngle of [false, true]) {
    const passages = existingAngle ? 'import { stripAngleMarkup } from "./angle-markup";\n' + oldPassages.replaceAll('standardizeSpeakerMarkup(stripZeroWidthSpaces(', 'standardizeSpeakerMarkup(stripAngleMarkup(stripZeroWidthSpaces(').replaceAll('content), names)', 'content)), names)').replaceAll('rawContent), names)', 'rawContent)), names)') : oldPassages;
    const files = { ...current, "passages.ts": passages };
    const next = upgradeVnMetadataFiles(files, angle);
    assert.match(next["passages.ts"], /import \{ stripGameStateDump, stripVariableUpdateTags \} from "\.\/metadata";/);
    assert.match(next["passages.ts"], /stripVariableUpdateTags\(stripZeroWidthSpaces\(content\)\)/);
    assert.match(next["passages.ts"], /stripVariableUpdateTags\(stripZeroWidthSpaces\(rawContent\)\)/);
    assert.equal(next["metadata.ts"], current["metadata.ts"]);
    assert.equal(upgradeVnMetadataFiles(next, angle), next);
  }
});

test("custom metadata imports, helper modules and incomplete passage anchors remain untouched", () => {
  const files = { ...current, "passages.ts": oldPassages };
  for (const passages of [
    oldPassages.replace('from "./metadata"', 'from "../creator/metadata"'),
    oldPassages.replace('import { stripGameStateDump }', 'import { stripGameStateDump as creatorFilter }'),
    oldPassages.replace('import { stripGameStateDump } from "./metadata";', ''),
    oldPassages.replace('import { stripGameStateDump } from "./metadata";', 'import { stripGameStateDump } from "./metadata";\nimport { stripGameStateDump } from "./metadata";'),
    oldPassages.replace('rawContent = standardizeSpeakerMarkup(stripZeroWidthSpaces(rawContent), names);', 'rawContent = creatorFormat(rawContent);'),
  ]) {
    const custom = { ...files, "passages.ts": passages };
    assert.equal(upgradeVnMetadataFiles(custom, angle), custom);
  }
  const customHelper = { ...files, "angle-markup.ts": "creator helper" };
  assert.equal(upgradeVnMetadataFiles(customHelper, angle), customHelper);
});


type MetadataPassage = { kind: string; text: string };
function inspectMetadata(content: string, files = current): { lines: MetadataPassage[]; choices: string[] } {
  const probe = 'import { passages, messageChoices } from "./passages"; export default function Probe(){const api=useYumina();return <pre>{JSON.stringify({lines:passages([],api.content),choices:messageChoices({role:"assistant",content:api.content})})}</pre>}';
  const compiled = bundleAndCompile({ files: { ...files, "probe.tsx": probe }, entryFile: "probe.tsx" }, () => ({ content }));
  assert.equal(compiled.error, null, compiled.error ?? undefined);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const dom = new JSDOM(renderToStaticMarkup(createElement(compiled.Component!)));
    try { return JSON.parse(dom.window.document.querySelector("pre")!.textContent!); }
    finally { dom.window.close(); }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "React", descriptor);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

const angleFirstCleanup = ['content', 'rawContent'].map(value => `  ${value} = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(${value}))), names);`).join('\n');
const snapshotFirstCleanup = ['content', 'rawContent'].map(value => `  ${value} = standardizeSpeakerMarkup(stripAngleMarkup(stripGameStateDump(stripVariableUpdateTags(stripZeroWidthSpaces(${value})))), names);`).join('\n');

function mixedSnapshot(open: string, close: string) {
  return `[SPEAKER:NPC:normal] "Enrolled."\n[CHOCIES: ["Step forward", "Help the boy"]]\n${open}\nacademy-day: 1\nplayer-wealth: 90\n${close}\n*The clerk returns to his desk.*`;
}

test("VN strips complete mixed snapshot wrappers before angle markup while keeping speech, narration and choices", () => {
  for (const [open, close] of [['[game-state]', '</game-state>'], ['<game-state>', '[/game-state]'], ['<game-state>', '</game-state>'], ['[game-state]', '[/game-state]']]) {
    const content = mixedSnapshot(open, close);
    const result = inspectMetadata(content);
    assert.deepEqual(result.lines.map(line => [line.kind, line.text]), [["dialogue", "Enrolled."], ["narration", "The clerk returns to his desk."]], `${open} ${close}`);
    assert.deepEqual(result.choices, ["Step forward", "Help the boy"]);
    assert.ok(content.includes(open) && content.includes(close), "display cleanup does not mutate the source response");
  }
});

test("VN snapshot cleanup preserves quoted examples, code and ordinary unwrapped narrative", () => {
  const cases: Array<[string, string[]]> = [
    ['[SPEAKER:NPC:normal] "The [game-state] marker is only an example."', ['The [game-state] marker is only an example.']],
    ['```text\n[game-state]\nacademy-day: 1\n</game-state>\n```', ['```text\n[game-state]\nacademy-day: 1\n</game-state>\n```']],
    ['`<game-state>` and `</game-state>` are examples.', ['`<game-state>`', 'and', '`</game-state>`', 'are examples.']],
    ['*The academy-day: 1 plaque is still on the desk.*', ['The academy-day: 1 plaque is still on the desk.']],
  ];
  for (const [content, expected] of cases) assert.deepEqual(inspectMetadata(content).lines.map(line => line.text), expected);
});

test("saved angle-first stock cleanup receives snapshot-first ordering without replacing authored files", () => {
  const legacy = current["passages.ts"].replace(snapshotFirstCleanup, angleFirstCleanup);
  assert.ok(legacy.includes(angleFirstCleanup));
  const files = { ...current, "passages.ts": legacy, "custom.ts": "export const caption = 'Authored';" };
  const next = upgradeVnMetadataFiles(files, angle);
  assert.notEqual(next, files);
  assert.equal(next["passages.ts"], current["passages.ts"]);
  assert.deepEqual(inspectMetadata(mixedSnapshot('[game-state]', '</game-state>'), next).lines.map(line => [line.kind, line.text]), [["dialogue", "Enrolled."], ["narration", "The clerk returns to his desk."]]);
  for (const [name, source] of Object.entries(files)) if (name !== "passages.ts") assert.equal(next[name], source, name);
  assert.equal(files["passages.ts"], legacy);
  assert.equal(upgradeVnMetadataFiles(next, angle), next);

  const nested = Object.fromEntries(Object.entries(files).map(([name, source]) => ['vn/' + name, source]));
  const nestedNext = upgradeVnMetadataFiles(nested, angle);
  assert.equal(nestedNext['vn/passages.ts'], current['passages.ts']);
  assert.deepEqual(Object.keys(nestedNext), Object.keys(nested));

  for (const source of [legacy.replace('stripGameStateDump(extractResponseChoices(content).text)', 'creatorSnapshotFilter(extractResponseChoices(content).text)'), legacy.replace('stripVariableUpdateTags(stripZeroWidthSpaces(rawContent))', 'creatorMetadata(rawContent)'), legacy.replace(angleFirstCleanup, angleFirstCleanup + '\n' + angleFirstCleanup)]) {
    const custom = { ...files, 'passages.ts': source };
    assert.equal(upgradeVnMetadataFiles(custom, angle), custom);
  }
});
