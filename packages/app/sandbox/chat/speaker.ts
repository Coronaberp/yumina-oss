/**
 * Which character is "speaking" an assistant message — drives the portrait +
 * name shown above the bubble in the default chat.
 *
 * Order of trust:
 *   1. The speaker tag the AI was asked to open the reply with
 *      (`[speaker: Name]`, see engine `speaker-tag.ts`). Known before any
 *      prose streams in. `narrator` means: no face.
 *   2. No tag (older history, a model that ignored the instruction, a
 *      greeting): a world with exactly one character is that character's
 *      voice, so every line gets their face. With several characters, a
 *      line-start marker like `Mia:` / `【Mia】` / `**Mia**:` names the
 *      speaker; failing that, a name inside the FIRST sentence; failing
 *      that, it is narration and keeps the plain label.
 */
import {
  displayCharacterName,
  characterIdentifiers,
  canonicalCharacterName,
  NARRATOR_SPEAKER,
  parseLeadingSpeakerTag,
  isPartialLeadingSpeakerTag,
} from "@yumina/engine";
import { speechAttribution } from "./dialogue-spans";
import { chatDialogueSpans } from "./chat-dialogue-spans";
import { markedSpeakerPassages } from "./speaker-markers";
import { hasMarkdownBlockStructure } from "../../src/lib/chat-markdown-blocks";

export { displayCharacterName, isPartialLeadingSpeakerTag };

export interface SpeakerEntry {
  name: string;
  role?: string;
  enabled?: boolean;
  portrait?: string | null;
  player?: boolean;
  playerName?: string;
}

export interface Speaker {
  name: string;
  /** null when the tagged character exists but has no portrait — the name
   *  still beats a generic "Narrator" label. */
  portrait: string | null;
}

/** The text a bubble should render: the leading tag never reaches the player. */
export function stripLeadingSpeakerTag(text: string): string {
  return parseLeadingSpeakerTag(text).text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toSpeaker(e: SpeakerEntry): Speaker {
  return {
    name: e.player ? e.playerName || "You" : displayCharacterName(e.name),
    portrait: typeof e.portrait === "string" && e.portrait.length > 0 ? e.portrait : null,
  };
}

function firstSentence(text: string): string {
  const t = text.trimStart();
  const m = /[.!?。！？\n]/.exec(t);
  return m ? t.slice(0, m.index) : t;
}

export function resolveSpeaker(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  rawContent: string,
): Speaker | null {
  if (!entries || entries.length === 0) return null;
  const characters = entries.filter(
    (e) => e.role === "character" && e.enabled !== false && displayCharacterName(e.name).length > 0,
  );
  if (characters.length === 0) return null;

  // 1. The tag.
  const tag = parseLeadingSpeakerTag(rawContent);
  if (tag.speaker === NARRATOR_SPEAKER) return null;
  if (tag.speaker) {
    const wanted = canonicalCharacterName(characters.map(c => displayCharacterName(c.name)), displayCharacterName(tag.speaker));
    const hit = characters.find(c => displayCharacterName(c.name) === wanted);
    if (hit) return toSpeaker(hit);
    // Unknown name: fall through and let the text decide.
  }

  // 2. Heuristics on the prose.
  const candidates = characters.filter((c) => typeof c.portrait === "string" && c.portrait.length > 0);
  if (candidates.length === 0) return null;
  if (characters.length === 1) return toSpeaker(characters[0]!);

  const text = tag.text;
  const firstLine = (text.trimStart().split("\n")[0] ?? "").trim();
  const identifiers = characterIdentifiers(characters.map(c => displayCharacterName(c.name)))
    .filter(({ name }) => candidates.some(c => displayCharacterName(c.name) === name));
  let best: SpeakerEntry | null = null;
  let bestName = "";
  for (const { name, identifier } of identifiers) {
    const c = candidates.find(c => displayCharacterName(c.name) === name)!;
    const marker = new RegExp(
      `^\\s*(?:\\*\\*|【|\\[|「|\\()?\\s*${escapeRegExp(identifier)}\\s*(?:\\*\\*|】|\\]|」|\\))?\\s*[:：]`,
      "i",
    );
    if (marker.test(firstLine) && name.length > bestName.length) {
      best = c;
      bestName = name;
    }
  }
  if (best) return toSpeaker(best);

  const sentence = firstSentence(text).toLowerCase();
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const { name, identifier } of identifiers) {
    const c = candidates.find(c => displayCharacterName(c.name) === name)!;
    const idx = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(identifier)}(?![\\p{L}\\p{N}])`, "iu").exec(sentence)?.index ?? -1;
    if (idx === -1) continue;
    if (idx < bestIdx || (idx === bestIdx && name.length > bestName.length)) {
      best = c;
      bestName = name;
      bestIdx = idx;
    }
  }
  return best ? toSpeaker(best) : null;
}

export interface SpeakerSection {
  speaker: Speaker | null;
  /** Original prose, including separators, so splitting never discards text. */
  text: string;
  /** Prose to render, with an explicit `Name:` label moved into the header. */
  content: string;
  emotion?: string;
  npcGender?: string;
  npcId?: string;
  scene?: string;
}

/** Split the display text, never the raw provider output: display rules and
 * server-side thinking/directive filtering must remain authoritative. Raw
 * output supplies only the legacy leading speaker tag for the first section. */
export function splitSpeakerSections(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  content: string,
  rawContent = content,
  options: { streaming?: boolean } = {},
): SpeakerSection[] {
  // Keep the original once-only tag's legacy behavior. Three-field engine
  // markers carry speaker identity until the next marker, across paragraphs.
  const display = parseLeadingSpeakerTag(content).text;
  const characters = (entries ?? []).filter(e => e.role === "character" && e.enabled !== false);
  const names = characters.map(e => displayCharacterName(e.name));
  const passages = markedSpeakerPassages(display, names, rawContent, !!options.streaming);
  if (!passages) return splitLegacySpeakerSections(entries, content, rawContent);
  const sections: SpeakerSection[] = [];
  let pendingSource = "";
  for (const passage of passages) {
    const name = passage.marker?.name;
    const character = name ? characters.find(e => displayCharacterName(e.name) === canonicalCharacterName(names, name)) : undefined;
    const speaker = name ? name.toLowerCase() === NARRATOR_SPEAKER ? null : character ? toSpeaker(character) : { name: "NPC", portrait: null } : undefined;
    const parts = splitLegacySpeakerSections(entries, passage.text, rawContent, speaker);
    pendingSource += passage.sourcePrefix;
    if (!parts.length) { pendingSource += passage.text; continue; }
    parts[0]!.text = pendingSource + parts[0]!.text;
    pendingSource = "";
    for (const part of parts) sections.push({ ...part,
      ...(passage.marker ? { emotion: part.speaker ? passage.marker.emotion : "normal", npcGender: passage.marker.npcGender, npcId: passage.marker.npcId } : {}),
      ...(passage.scene ? { scene: passage.scene } : {}),
    });
  }
  if (pendingSource && sections.length) sections.at(-1)!.text += pendingSource;
  return sections;
}

function splitLegacySpeakerSections(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  content: string,
  rawContent: string,
  forcedSpeaker?: Speaker | null,
): SpeakerSection[] {
  const contentTag = parseLeadingSpeakerTag(content);
  content = contentTag.text;
  if (!content.trim()) return [];
  const characters = (entries ?? []).filter(
    e => e.role === "character" && e.enabled !== false && displayCharacterName(e.name).length > 0,
  ).slice().sort((a, b) => displayCharacterName(b.name).length - displayCharacterName(a.name).length);
  const prefix = "^(\\s*)(?:\\*\\*|\\*|__|_|【|\\[|「|\\()?";
  const suffix = "(?:\\*\\*|\\*|__|_|】|\\]|」|\\))?\\s*[:：][\\t ]*";
  const identifiers = characterIdentifiers(characters.map(e => displayCharacterName(e.name)));
  const npc = { name: "NPC", portrait: null };
  const labels = [
    { pattern: new RegExp(`${prefix}Narrator${suffix}`, "i"), speaker: null },
    ...identifiers.map(({ name, identifier }) => ({
      pattern: new RegExp(`${prefix}${escapeRegExp(identifier)}${suffix}`, "i"),
      speaker: toSpeaker(characters.find(e => displayCharacterName(e.name) === name)!),
    })),
    { pattern: new RegExp(`${prefix}NPC${suffix}`, "i"), speaker: npc },
  ];
  const isIndentedCode = (text: string) => /^(?:[\t ]*\r?\n)*(?: {4}|\t)/.test(text);
  const explicitLabel = (text: string) => {
    if (isIndentedCode(text)) return null;
    for (const label of labels) {
      const match = label.pattern.exec(text);
      if (match) return { speaker: label.speaker, content: match[1]! + text.slice(match[0].length) };
    }
    return null;
  };
  const rawTag = parseLeadingSpeakerTag(rawContent);
  const tag = rawTag.speaker ? rawTag : contentTag;
  const taggedName = tag.speaker ? canonicalCharacterName(characters.map(e => displayCharacterName(e.name)), displayCharacterName(tag.speaker)) : null;
  const taggedCharacter = taggedName ? characters.find(e => displayCharacterName(e.name) === taggedName) : undefined;
  const hasInitialSpeaker = !!tag.speaker;
  const initialSpeaker = taggedCharacter ? toSpeaker(taggedCharacter) : tag.speaker && tag.speaker !== NARRATOR_SPEAKER ? npc : null;

  // Only cut outside fenced blocks. Retain the whole message when raw HTML
  // containers are present; a split must not leave unbalanced DOM fragments.
  const cuts = new Set([0]);
  let offset = 0;
  let blankStart: number | undefined;
  let fence: { char: string; length: number } | null = null;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      offset += line.length;
      continue;
    }
    if (/^ {0,3}<(?:!--|\/?(?:div|table|section|article|details|ul|ol|form|p|pre|script|style)\b)/i.test(line)) {
      return [{ speaker: hasInitialSpeaker ? initialSpeaker : resolveSpeaker(entries, content), text: content, content }];
    }
    if (!line.trim()) {
      blankStart ??= offset;
    } else {
      if (blankStart !== undefined) {
        if (blankStart > 0) cuts.add(blankStart);
        blankStart = undefined;
      } else if (offset > 0 && explicitLabel(line)) {
        cuts.add(offset);
      }
      if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    }
    offset += line.length;
  }
  const starts = [...cuts].sort((a, b) => a - b);
  const sections: SpeakerSection[] = [];
  const names = characters.map(e => displayCharacterName(e.name));
  const paragraphCharacter = (text: string) => {
    if (isIndentedCode(text)) return undefined;
    const found = identifiers.find(({ identifier }) => new RegExp(
      `${prefix}${escapeRegExp(identifier)}(?=$|[\\s:：,，.!?。！？]|['’]s\\b|\\*|_|】|\\]|」|\\))`, "i",
    ).test(text));
    return found ? characters.find(e => displayCharacterName(e.name) === found.name) : undefined;
  };
  const append = (speaker: Speaker | null, text: string, content: string) => {
    const previous = sections.at(-1);
    if (previous && previous.speaker?.name === speaker?.name && previous.speaker?.portrait === speaker?.portrait) {
      previous.text += text;
      previous.content += content;
    } else sections.push({ speaker, text, content });
  };
  for (let i = 0; i < starts.length; i++) {
    const text = content.slice(starts[i], starts[i + 1] ?? content.length);
    const label = forcedSpeaker === undefined ? explicitLabel(text) : null;
    const prose = label?.content ?? text;
    if (hasMarkdownBlockStructure(prose)) {
      append(forcedSpeaker !== undefined ? forcedSpeaker : label?.speaker ?? null, text, prose);
      continue;
    }
    const named = paragraphCharacter(prose);
    let context = forcedSpeaker !== undefined ? forcedSpeaker : label ? label.speaker : named ? toSpeaker(named) : i === 0 && hasInitialSpeaker ? initialSpeaker : characters.length === 1 ? toSpeaker(characters[0]!) : null;
    const spans = isIndentedCode(prose) ? [{ kind: "literal" as const, text: prose, end: prose.length }] : chatDialogueSpans(prose);
    const adjacentAttribution = (index: number) => {
      const neighbor = spans[index];
      // Unquoted roleplay needs an explicit, adjacent italic speech
      // attribution. A mentioned name or an ordinary action is not enough.
      return neighbor?.kind === "action" && /^(?:\*(?!\*)|_(?!_))/.test(neighbor.text)
        ? speechAttribution(neighbor.text, names) : null;
    };
    let previousDialogueEnd = 0;
    let pendingText = "";
    let pendingContent = "";
    for (let j = 0; j < spans.length; j++) {
      const span = spans[j]!;
      let source = span.text;
      if (j === 0 && label) {
        const gap = /^\s*/.exec(prose)![0].length;
        source = text.slice(0, gap + text.length - prose.length) + source.slice(gap);
      }
      if (!span.text.trim()) {
        pendingText += source; pendingContent += span.text; continue;
      }
      let resolved: Speaker | null = null;
      if (span.kind === "dialogue") {
        const preceding = prose.slice(previousDialogueEnd, span.end - span.text.length);
        // Use only the adjacent prose clause, so an earlier sentence naming
        // a speaker cannot take ownership of a later unattributed quotation.
        const adjacent = preceding.slice(Math.max(...[".", "!", "?", "\n"].map(boundary => preceding.lastIndexOf(boundary))) + 1).replace(/^[\s*_]+/, "");
        const before = speechAttribution(adjacent, names);
        const attribution = before.matched ? before : speechAttribution(prose.slice(span.end), names);
        if (forcedSpeaker === undefined && !label && attribution.matched) {
          const attributed = characters.find(e => displayCharacterName(e.name) === attribution.name);
          context = attributed ? toSpeaker(attributed) : null;
        }
        resolved = label ? label.speaker : context;
        if (!resolved && forcedSpeaker === undefined && !(label && !label.speaker) && !(i === 0 && tag.speaker === NARRATOR_SPEAKER)) resolved = npc;
        previousDialogueEnd = span.end;
      } else if (span.kind === "action") {
        // Bold text under an explicit dialogue label remains emphasized
        // speech; single-asterisk stage directions remain narration.
        if (/^(?:\*\*|__)/.test(span.text)) resolved = forcedSpeaker !== undefined ? forcedSpeaker : label?.speaker ?? null;
        const actor = paragraphCharacter(span.text);
        if (forcedSpeaker === undefined && !label && actor) context = toSpeaker(actor);
      } else if (span.kind === "text" && (forcedSpeaker !== undefined || label || (i === 0 && hasInitialSpeaker))) {
        // Explicit labels retain ownership of plain speech. Italic actions
        // remain narrator text, even in one-character worlds.
        resolved = forcedSpeaker !== undefined ? forcedSpeaker : label ? label.speaker : initialSpeaker;
      } else if (span.kind === "text") {
        const before = adjacentAttribution(j - 1);
        const after = adjacentAttribution(j + 1);
        const attribution = after?.matched ? after : before;
        if (attribution?.matched && attribution.name && !(before?.matched && after?.matched && before.name !== after.name)) {
          const attributed = characters.find(e => displayCharacterName(e.name) === attribution.name);
          resolved = attributed ? toSpeaker(attributed) : npc;
        }
      }
      append(resolved, pendingText + source, pendingContent + span.text);
      pendingText = ""; pendingContent = "";
    }
    if (pendingText) {
      const previous = sections.at(-1);
      if (previous) { previous.text += pendingText; previous.content += pendingContent; }
    }
  }
  return sections;
}
