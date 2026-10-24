import type { DialogueSpan } from "./dialogue-spans";
// Adapted from the existing Yumina chat speaker parser; presentation only.
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
import { displayCharacterName, characterIdentifiers, canonicalCharacterName, NARRATOR_SPEAKER, parseLeadingSpeakerTag, isPartialLeadingSpeakerTag } from "./speaker-tag";
import { speechAttribution, legacyQuoteSpeakers } from "./dialogue-spans";
import { vnDialogueSpans as dialogueSpans } from "./vn-dialogue-spans";

export { displayCharacterName, isPartialLeadingSpeakerTag };

export interface SpeakerEntry {
  name: string;
  role?: string;
  enabled?: boolean;
  portrait?: string | null;
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
    name: displayCharacterName(e.name),
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
  /** Retain classification across speaker sections rather than parsing fragments again. */
  spans?: DialogueSpan[];
}

/** Split the display text, never the raw provider output: display rules and
 * server-side thinking/directive filtering must remain authoritative. Raw
 * output supplies only the legacy leading speaker tag for the first section.
 * A VN marker can pin that speaker until the next marker; explicit paragraph
 * labels still take precedence, and actions always remain narration. */
export function splitSpeakerSections(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  content: string,
  rawContent = content,
  pinSpeaker = false,
): SpeakerSection[] {
  const contentTag = parseLeadingSpeakerTag(content);
  content = contentTag.text;
  if (!content.trim()) return [];
  const characters = (entries ?? []).filter(
    e => e.role === "character" && e.enabled !== false && displayCharacterName(e.name).length > 0,
  ).slice().sort((a, b) => displayCharacterName(b.name).length - displayCharacterName(a.name).length);
  const names = characters.map(e => displayCharacterName(e.name));
  const prefix = "^(\\s*)(?:\\*\\*|\\*|__|_|【|\\[|「|\\()?";
  const suffix = "(?:\\*\\*|\\*|__|_|】|\\]|」|\\))?\\s*[:：][\\t ]*";
  const identifiers = characterIdentifiers(characters.map(e => displayCharacterName(e.name)));
  const labels = [
    { pattern: new RegExp(`${prefix}Narrator${suffix}`, "i"), speaker: null },
    ...identifiers.map(({ name, identifier }) => ({
      pattern: new RegExp(`${prefix}${escapeRegExp(identifier)}${suffix}`, "i"),
      speaker: toSpeaker(characters.find(e => displayCharacterName(e.name) === name)!),
    })),
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
  const hasInitialSpeaker = tag.speaker === NARRATOR_SPEAKER || !!taggedCharacter;
  const initialSpeaker = taggedCharacter ? toSpeaker(taggedCharacter) : null;

  // Only cut outside fenced blocks. Retain the whole message when raw HTML
  // containers are present; a split must not leave unbalanced DOM fragments.
  const protectedSpans = dialogueSpans(content, names).filter(span => span.kind !== "text");
  const insideSpan = (offset: number) => protectedSpans.some(span => offset > span.end - span.text.length && offset < span.end);
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
        if (blankStart > 0 && !insideSpan(blankStart)) cuts.add(blankStart);
        blankStart = undefined;
      } else if (offset > 0 && !insideSpan(offset) && explicitLabel(line)) {
        cuts.add(offset);
      }
      if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    }
    offset += line.length;
  }
  const starts = [...cuts].sort((a, b) => a - b);
  const sections: SpeakerSection[] = [];
  const recovered = tag.speaker ? new Map<number, string>() : legacyQuoteSpeakers(content, names, dialogueSpans(content, names));
  const paragraphCharacter = (text: string) => isIndentedCode(text) ? undefined : characters.find(e => new RegExp(
    `${prefix}${escapeRegExp(displayCharacterName(e.name))}(?=$|[\\s:：,，.!?。！？]|['’]s\\b|\\*|_|】|\\]|」|\\))`, "i",
  ).test(text));
  const append = (speaker: Speaker | null, text: string, content: string, span: DialogueSpan) => {
    const previous = sections.at(-1);
    if (previous && previous.speaker?.name === speaker?.name && previous.speaker?.portrait === speaker?.portrait) {
      previous.text += text;
      previous.content += content;
      previous.spans!.push({ ...span, text: content });
    } else sections.push({ speaker, text, content, spans: [{ ...span, text: content }] });
  };
  for (let i = 0; i < starts.length; i++) {
    const text = content.slice(starts[i], starts[i + 1] ?? content.length);
    const label = explicitLabel(text);
    const prose = label?.content ?? text;
    const named = paragraphCharacter(prose);
    let context = label ? label.speaker : pinSpeaker || (i === 0 && hasInitialSpeaker) ? initialSpeaker : characters.length === 1 ? toSpeaker(characters[0]!) : null;
    const spans = isIndentedCode(prose) ? [{ kind: "literal" as const, text: prose, end: prose.length }] : dialogueSpans(prose, names);
    const adjacentAttribution = (index: number) => {
      const neighbor = spans[index];
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
        if (!label && !pinSpeaker && attribution.matched) {
          const attributed = characters.find(e => displayCharacterName(e.name) === attribution.name);
          context = attributed ? toSpeaker(attributed) : null;
        }
        if (!label && !pinSpeaker) {
          const recoveredName = recovered.get(starts[i]! + text.length - prose.length + span.end);
          const recoveredEntry = characters.find(e => displayCharacterName(e.name) === recoveredName);
          if (recoveredEntry) context = toSpeaker(recoveredEntry);
        }
        resolved = label ? label.speaker : context;
        previousDialogueEnd = span.end;
      } else if (span.kind === "action") {
        // Keep the action narrated, but a named speech attribution such as
        // *Evelia says...* can connect the next quote in this paragraph.
        // An unrelated action clears that context instead of guessing.
        if (!label && !pinSpeaker && !(i === 0 && hasInitialSpeaker)) {
          const attribution = speechAttribution(span.text, names);
          const attributed = characters.find(e => displayCharacterName(e.name) === attribution.name);
          context = attributed ? toSpeaker(attributed) : null;
        }
      } else if (span.kind === "text" && label) {
        // Plain `Name: dialogue` remains compatible. Unlabelled prose and
        // all italic actions are narrator text, even in one-character worlds.
        resolved = label.speaker;
      } else if (span.kind === "text" && !pinSpeaker) {
        const before = adjacentAttribution(j - 1), after = adjacentAttribution(j + 1);
        const attribution = after?.matched ? after : before;
        if (attribution?.matched && attribution.name && !(before?.matched && after?.matched && before.name !== after.name)) {
          const attributed = characters.find(entry => displayCharacterName(entry.name) === attribution.name);
          resolved = attributed ? toSpeaker(attributed) : null;
        }
      }
      append(resolved, pendingText + source, pendingContent + span.text, span);
      pendingText = ""; pendingContent = "";
    }
    if (pendingText) {
      const previous = sections.at(-1);
      if (previous) { previous.text += pendingText; previous.content += pendingContent; previous.spans!.at(-1)!.text += pendingContent; }
    }
  }
  return sections;
}
