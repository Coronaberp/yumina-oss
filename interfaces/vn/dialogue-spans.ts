import { characterIdentifiers } from "./speaker-tag";
import { presentationLiteralRanges, presentationQuoteEnd } from "./presentation-literals";

/** Presentation-only spans. Quotes own their inner formatting; emphasis
 * outside a quote is a narrated action. Code and image/link syntax are opaque. */
export interface DialogueSpan {
  kind: "dialogue" | "action" | "text" | "literal";
  text: string;
  end: number;
}

const quotePairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "「": "」", "『": "』" };
const word = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);

export function dialogueSpans(text: string): DialogueSpan[] {
  const spans: DialogueSpan[] = [];
  const opaqueRanges = new Map(presentationLiteralRanges(text).filter(range => !quotePairs[text[range.start]!] && text[range.start] !== "\\").map(range => [range.start, { end: range.end, kind: /^!?\[/.test(text.slice(range.start)) ? "text" as const : "literal" as const }]));
  const append = (kind: DialogueSpan["kind"], start: number, end: number) => {
    const previous = spans.at(-1);
    if (kind === "text" && previous?.kind === "text") {
      previous.text += text.slice(start, end);
      previous.end = end;
    } else spans.push({ kind, text: text.slice(start, end), end });
  };
  let i = 0;
  while (i < text.length) {
    const opaqueRange = opaqueRanges.get(i);
    if (opaqueRange) { append(opaqueRange.kind, i, opaqueRange.end); i = opaqueRange.end; continue; }
    const rest = text.slice(i);
    if ((i === 0 || text[i - 1] === "\n") && /^(?: {4}|\t)\S/.test(rest)) {
      const block = /^(?:(?: {4}|\t)[^\n]*(?:\n|$))+/u.exec(rest)![0];
      append("literal", i, i + block.length); i += block.length; continue;
    }
    const fence = (i === 0 || text[i - 1] === "\n") && /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[\\t ]*\\r?$`, "gm");
      close.lastIndex = i + fence[0].length;
      const match = close.exec(text);
      const end = match ? match.index + match[0].length : text.length;
      append("literal", i, end); i = end; continue;
    }
    const opaque = /^(?:!?\[[^\]\n]*\]\([^()\n]*\)|<[^>\n]*>)/.exec(rest);
    if (opaque) { append("text", i, i + opaque[0].length); i += opaque[0].length; continue; }
    if (text[i] === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const close = text.indexOf(ticks, i + ticks.length);
      const end = close < 0 ? text.length : close + ticks.length;
      append("literal", i, end); i = end; continue;
    }
    if (text[i] === "\\" && i + 1 < text.length) { append("text", i, i + 2); i += 2; continue; }
    const closing = quotePairs[text[i]!];
    if (closing && !((text[i] === "'" || text[i] === "‘") && (word(text[i - 1]) || /\{\{(?:user|char)\}\}$/i.test(text.slice(0, i))))) {
      const end = presentationQuoteEnd(text, i);
      append("dialogue", i, end); i = end; continue;
    }
    const delimiter = text[i];
    const run = /^(\*{1,3}|_{1,3})(?![*_])/.exec(rest)?.[0];
    if (run && text[i - 1] !== delimiter && !/\s/.test(text[i + run.length] ?? " ") && !(delimiter === "_" && word(text[i - 1]))) {
      let end = i + run.length, nested = 0;
      while (end < text.length) {
        if (text[end] === "\\") { end += 2; continue; }
        const quoteClose = quotePairs[text[end]!];
        if (quoteClose && !((text[end] === "'" || text[end] === "‘") && (word(text[end - 1]) || /\{\{(?:user|char)\}\}$/i.test(text.slice(0, end))))) {
          const close = presentationQuoteEnd(text, end);
          if (text[close - 1] === quoteClose) { end = close; continue; }
        }
        if (text.slice(end, end + run.length) === run && text[end - 1] !== delimiter && text[end + run.length] !== delimiter) {
          const opens = !word(text[end - 1]) && !/\s/.test(text[end + run.length] || " ");
          const closes = !word(text[end + run.length]) && (!/\s/.test(text[end - 1] || " ") || /^[\t ]*(?:["“«「『]|$)/.test(text.slice(end + run.length)));
          if (opens && !closes) { nested++; end += run.length; continue; }
          if (closes && nested > 0) { nested--; end += run.length; continue; }
          if (closes) break;
        }
        if (text[end] === "\n" && /^\n[\t ]*\[\s*(?:SPEAKER|Name|SCENE)\s*:/i.test(text.slice(end))) {
          // An incomplete action stops before the next structural passage.
          append("action", i, end); i = end; end = -1; break;
        }
        end++;
      }
      if (end < 0) continue;
      end = Math.min(end + run.length, text.length);
      append("action", i, end); i = end; continue;
    }
    append("text", i, i + 1); i++;
  }
  return spans;
}

const speechVerb = "(?:says?|said|asks?|asked|repl(?:y|ies|ied)|whispers?|whispered|murmurs?|murmured|mutters?|muttered|answers?|answered|responds?|responded|shouts?|shouted|yells?|yelled|calls?|called|exclaims?|exclaimed|adds?|added|breathes?|breathed|insists?|insisted|stammers?|stammered|remarks?|remarked|states?|stated|hisses?|hissed|retorts?|retorted|warns?|warned|cries|cried|demands?|demanded|commands?|commanded|continues?|continued)\\b";
const decoration = "(?:\\*{1,2}|_{1,2})?";
const attributionStart = `^[\\s,.;:!?—–-]*${decoration}`;

/** Only a name immediately attached to a speech verb OUTSIDE dialogue is an
 * attribution. An unknown/disabled name is explicit too, so it cannot fall
 * back to an unrelated single-character portrait. */
export function speechAttribution(text: string, names: ReadonlyArray<string>): { matched: boolean; name: string | null } {
  // An attribution in a new paragraph belongs to that paragraph's quote,
  // never to the previous speaker's final line.
  if (/^[\t ]*(?:\r?\n[\t ]*){2}/.test(text)) return { matched: false, name: null };
  for (const { name, identifier } of characterIdentifiers(names)) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forward = `${attributionStart}${escaped}${decoration}\\s+${speechVerb}`;
    const reversed = `${attributionStart}${speechVerb}\\s+${decoration}${escaped}(?=$|[\\s,.;:!?—–*_-])`;
    if (new RegExp(`${forward}|${reversed}`, "iu").test(text)) return { matched: true, name };
  }
  const unknownName = "[\\p{L}\\p{N}][\\p{L}\\p{N}'’.-]*(?:\\s+[\\p{L}\\p{N}][\\p{L}\\p{N}'’.-]*){0,3}";
  const unknown = new RegExp(`${attributionStart}${unknownName}${decoration}\\s+${speechVerb}|${attributionStart}${speechVerb}\\s+${decoration}${unknownName}`, "iu");
  return { matched: unknown.test(text), name: null };
}

/** Emphasis is not an action inside spoken text. Keep the source in raw
 * output while displaying escaped, nested, or bold star markup as plain text. */
export function plainDialogue(text: string): string {
  let result = text.replace(/\\(?=\*)/g, "");
  let previous: string;
  do {
    previous = result;
    result = result.replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2");
  } while (result !== previous);
  return result;
}

/** Recover unmarked legacy quotes only from explicit speech attribution or
 * a single named action subject. Quotes never contribute names, and code,
 * unknown actors and multiple named characters clear the fallback. */
export function legacyQuoteSpeakers(text: string, names: ReadonlyArray<string>): Map<number, string> {
  const result = new Map<number, string>();
  let subject: string | null = null, paragraphSpeaker: string | null = null, pendingActor: string | null = null;
  let previousQuoteEnd = 0;
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifiers = characterIdentifiers(names);
  const singularSpeech = (value: string) => new RegExp(`${attributionStart}(?:she|he)${decoration}\\s+${speechVerb}`, "iu").test(value);
  const actionVerb = "(?:takes?|took|steps?|stepped|moves?|moved|looks?|looked|stands?|stood|sits?|sat|walks?|walked|enters?|entered|turns?|turned|smiles?|smiled|nods?|nodded|pauses?|paused|sets?|puts?|places?|placed|reach(?:es|ed)?|waits?|holds?|held|pours?|poured|watches?|watched|opens?|opened|closes?|closed|lifts?|lifted|swallows?|swallowed|is|was|has|had|does|did)\\b";
  const bodyPart = "(?:hands?|eyes?|voice|tail|breath|ears?|face|head|mouth|fingers?|smile|gaze|shoulders?)\\b";
  const actorIn = (value: string) => {
    const identified = identifiers.flatMap(({ name, identifier }) => [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(identifier)}(?![\\p{L}\\p{N}])`, "giu"))].map(match => ({ name, start: match.index!, end: match.index! + match[0].length })));
    const mentioned = [...new Set(identified.map(({ name }) => name))];
    const candidate = mentioned.length === 1 ? mentioned[0]! : null;
    const action = candidate && identifiers.some(({ name, identifier }) => name === candidate && new RegExp(`(?<![\\p{L}\\p{N}])${escape(identifier)}(?:\\s+(?:[\\p{L}-]+ly\\s+)*${actionVerb}|['’]s\\s+${bodyPart})`, "iu").test(value));
    const unknownActor = new RegExp(`(?<![\\p{L}\\p{N}])([A-Z][\\p{L}'’.-]*)\\s+(?:[\\p{L}-]+ly\\s+)*${actionVerb}`, "gu");
    // A fragment such as B in A+B is part of the known actor, not another one.
    const otherActor = [...value.matchAll(unknownActor)].some(match => !/^(?:a|an|the)$/i.test(match[1]!) && !identified.some(({ name, start, end }) => name === candidate && match.index! >= start && match.index! + match[1]!.length <= end));
    const unnamedActor = !action && new RegExp(`^\\s*${decoration}(?:the|a|an)\\s+[\\p{L}-]+\\s+${actionVerb}`, "iu").test(value);
    const playerOrPronoun = /^\s*(?:\*{1,3}|_{1,3})?(?:\{\{user\}\}|the player|you|she|he|they)(?=$|\s|['’])/i.test(value);
    return { name: action && !otherActor && !playerOrPronoun ? candidate : null, ambiguous: mentioned.length > 0 || otherActor || unnamedActor || playerOrPronoun };
  };
  for (const span of dialogueSpans(text)) {
    if (span.kind === "dialogue") {
      const start = span.end - span.text.length;
      const preceding = text.slice(previousQuoteEnd, start);
      const adjacent = preceding.slice(Math.max(...[".", "!", "?", "\n"].map(boundary => preceding.lastIndexOf(boundary))) + 1);
      const after = text.slice(span.end);
      const beforeAttribution = speechAttribution(adjacent, names);
      const attributionText = beforeAttribution.matched ? adjacent : after;
      const attribution = beforeAttribution.matched ? beforeAttribution : speechAttribution(after, names);
      if (attribution.matched) paragraphSpeaker = attribution.name || (singularSpeech(attributionText) ? subject : null);
      else paragraphSpeaker ||= pendingActor;
      if (paragraphSpeaker) result.set(span.end, paragraphSpeaker);
      pendingActor = null;
      previousQuoteEnd = span.end;
    } else {
      if (/\n\s*\n/.test(span.text)) { paragraphSpeaker = null; if (!pendingActor) subject = null; }
      if (!span.text.trim()) continue;
      if (span.kind === "literal") { subject = null; paragraphSpeaker = null; pendingActor = null; continue; }
      const speech = speechAttribution(span.text, names);
      if (speech.matched) {
        paragraphSpeaker = speech.name || (singularSpeech(span.text) ? subject : null);
        subject = paragraphSpeaker; pendingActor = null;
        continue;
      }
      const actor = actorIn(span.text);
      if (actor.name) { subject = actor.name; paragraphSpeaker = null; pendingActor = actor.name; }
      else if (actor.ambiguous) { subject = null; paragraphSpeaker = null; pendingActor = null; }
      else { pendingActor = null; subject = paragraphSpeaker; }
    }
  }
  return result;
}
