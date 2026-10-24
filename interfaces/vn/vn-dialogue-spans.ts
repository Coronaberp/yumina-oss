import type { DialogueSpan } from "./dialogue-spans";
import { dialogueSpans, plainDialogue, speechAttribution } from "./dialogue-spans";
import { isPresentationLiteral, maskPresentationLiterals, presentationLiteralRanges, presentationQuoteEnd } from "./presentation-literals";

const quotes: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "「": "」", "『": "』" };
interface VnDialogueSpan extends DialogueSpan { quoteStart?: boolean; quoteEnd?: boolean }

function separatorRanges(text: string) {
  const protectedRanges = presentationLiteralRanges(text);
  return [...text.matchAll(/^ {0,3}(?:(?:-[\t ]*){3,}|(?:\*[\t ]*){3,}|(?:_[\t ]*){3,})\r?$/gm)]
    .filter(match => !isPresentationLiteral(protectedRanges, match.index!))
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
}

/** Discard structural rules only; the saved reply and literal examples stay intact. */
export function stripVnSeparators(text: string): string {
  let result = "", cursor = 0;
  for (const range of separatorRanges(text)) {
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

/** A combined opening *** can mean an outer italic action and inner bold
 * word. Recognize that bounded shape without changing the shared lexer. */
function combinedAction(text: string): boolean {
  text = text.replace(/\\(["'“”‘’«»「」『』])/g, "$1");
  const opening = /^(\*{3}|_{3})/.exec(text)?.[0];
  if (!opening || !quotes[text[3]!]) return false;
  const delimiter = opening[0]!;
  const quoteEnd = presentationQuoteEnd(text, 3);
  return text[quoteEnd - 1] === quotes[text[3]!]
    && text.slice(quoteEnd, quoteEnd + 2) === delimiter.repeat(2)
    && text.endsWith(delimiter) && text.at(-2) !== delimiter
    && text.at(-2) !== "\\";
}

function plainQuotedSpan(text: string): boolean {
  const wrapper = /^(\*\*|__)([\s\S]*)\1$/.exec(text);
  if (!wrapper) return false;
  const inner = wrapper[2]!.replace(/\\(["'“”‘’«»「」『』])/g, "$1");
  const closing = quotes[inner[0]!];
  return !!closing && inner.at(-1) === closing && presentationQuoteEnd(inner, 0) === inner.length;
}

/** Split only explicit italic speech attributions within one legacy quote.
 * Offset and source bytes remain original, including quote boundaries. */
function splitAttributedQuote(span: DialogueSpan, names: ReadonlyArray<string>): VnDialogueSpan[] {
  if (span.kind !== "dialogue" || !quotes[span.text[0]!]) return [span];
  const outerStart = span.end - span.text.length;
  const balanced = span.text.at(-1) === quotes[span.text[0]!];
  const inner = span.text.slice(1, balanced ? -1 : undefined);
  const attributions = dialogueSpans(inner).filter(part => {
    if (part.kind !== "action" || !/^(?:\*(?!\*)|_(?!_))/.test(part.text)) return false;
    const actor = part.text.replace(/^[*_]+\s*/, "");
    // First/second-person emphasis is still part of the spoken sentence.
    if (/^(?:I|we|you|it|this|that)\b/i.test(actor)) return false;
    // Inside quotes, generic subjects such as "everyone says" remain speech.
    // Split only a known character or an explicit third-person attribution.
    return speechAttribution(part.text, [...names, "he", "she", "they"]).name !== null;
  });
  if (!attributions.length) return [span];
  const result: VnDialogueSpan[] = [];
  let cursor = 0;
  for (const part of attributions) {
    const start = 1 + part.end - part.text.length;
    const end = 1 + part.end;
    if (start > cursor) result.push({ kind: "dialogue", text: span.text.slice(cursor, start), end: outerStart + start, quoteStart: cursor === 0, quoteEnd: false });
    result.push({ kind: "action", text: span.text.slice(start, end), end: outerStart + end });
    cursor = end;
  }
  if (cursor < span.text.length) result.push({ kind: "dialogue", text: span.text.slice(cursor), end: span.end, quoteStart: false, quoteEnd: balanced });
  return result;
}

/** VN-only compatibility. The Chat lexer and original response are unchanged. */
export function vnDialogueSpans(text: string, names: ReadonlyArray<string> = []): VnDialogueSpan[] {
  const protectedRanges = presentationLiteralRanges(text);
  const special: Array<{ start: number; end: number; kind: "action" | "separator" }> = separatorRanges(text).map(range => ({ ...range, kind: "separator" }));
  for (const match of text.matchAll(/^ {0,3}(\*|_)[\t ]+\S[^\r\n]*\1[\t ]*\r?$/gm)) {
    const value = match[0].trimEnd();
    const padding = /^ */.exec(value)![0].length;
    const source = value.slice(padding);
    const start = match.index! + padding;
    if (!isPresentationLiteral(protectedRanges, start) && source.at(-2) !== source[0] && source.at(-2) !== "\\") {
      special.push({ start, end: start + source.length, kind: "action" });
    }
  }
  for (const match of text.matchAll(/^ {0,3}[^\r\n]+(?:\r?\n(?![\t ]*\r?$)[^\r\n]+)*/gm)) {
    const value = match[0].trimEnd();
    const padding = /^ */.exec(value)![0].length;
    const source = value.slice(padding);
    const start = match.index! + padding;
    if (isPresentationLiteral(protectedRanges, start)) continue;
    if (combinedAction(source)) special.push({ start, end: start + source.length, kind: "action" });
  }
  special.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: VnDialogueSpan[] = [];
  const append = (source: string, start: number) => {
    for (const span of dialogueSpans(source)) {
      const adjusted = { ...span, end: start + span.end };
      if (span.kind === "action" && plainQuotedSpan(span.text)) result.push({ ...adjusted, kind: "dialogue" });
      else result.push(...splitAttributedQuote(adjusted, names));
    }
  };
  let cursor = 0;
  for (const range of special) {
    if (range.start < cursor) continue;
    if (range.start > cursor) append(text.slice(cursor, range.start), cursor);
    if (range.kind === "action") result.push({ kind: "action", text: text.slice(range.start, range.end), end: range.end });
    cursor = range.end;
  }
  if (cursor < text.length) append(text.slice(cursor), cursor);
  return result;
}

/** Remove action framing while preserving valid inner bold markup. */
export function vnPlainAction(text: string): string {
  if (combinedAction(text)) return text.slice(1, -1).trim();
  const marker = /^(\*{1,3}|_{1,3})/.exec(text)?.[0] || "";
  if (!marker) return text;
  let result = text.slice(marker.length);
  if (result.endsWith(marker) && result.at(-marker.length - 1) !== "\\") result = result.slice(0, -marker.length);
  return result.trim();
}

/** Speech fragments may own only one original outer quote boundary. */
export function vnPlainDialogue(text: string, span?: { quoteStart?: boolean; quoteEnd?: boolean }): string {
  let result = text.trim();
  if (span?.quoteStart !== undefined) {
    if (span.quoteStart) result = result.slice(1);
    if (span.quoteEnd) result = result.slice(0, -1);
    const masked = maskPresentationLiterals(result);
    return masked.restore(plainDialogue(masked.text)).trim();
  }
  if (plainQuotedSpan(result)) result = result.slice(2, -2);
  if (/^\\["“‘«「『]/.test(result) && /\\["”’»」』]$/.test(result)) result = result.slice(2, -2);
  else {
    const opener = quotes[result[0]!];
    if (opener) {
      result = result.slice(1);
      if (result.endsWith(opener)) result = result.slice(0, -1);
    }
  }
  // Legacy escaped quotation wrappers belong to speech, unlike escaped stars
  // or punctuation within it. Literal code/link contents remain untouched.
  const masked = maskPresentationLiterals(result);
  return masked.restore(plainDialogue(masked.text)).trim();
}
