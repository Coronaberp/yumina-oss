import { presentationLiteralRanges, presentationQuoteEnd } from "@yumina/engine";
import { dialogueSpans, type DialogueSpan } from "./dialogue-spans";

/** Chat retains Markdown rather than flattening spoken formatting. The VN's
 * shared lexer stays unchanged; recover its legacy escaped/bold quotations
 * only for Chat's attribution, without changing their original bytes. */
export function chatDialogueSpans(source: string): DialogueSpan[] {
  const spans: DialogueSpan[] = [];
  const closing: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "「": "」", "『": "』" };
  const protectedRanges = presentationLiteralRanges(source).filter(range => source[range.start] !== "\\");
  for (const span of dialogueSpans(source)) {
    const bold = span.kind === "action" && /^(\*\*|__)([\s\S]*)\1$/.exec(span.text);
    const inner = bold ? bold[2]!.replace(/\\(["'“”‘’«»「」『』])/g, "$1") : "";
    if (bold && closing[inner[0]!] && inner.at(-1) === closing[inner[0]!] && presentationQuoteEnd(inner, 0) === inner.length) {
      spans.push({ ...span, kind: "dialogue" });
      continue;
    }
    if (span.kind !== "text") { spans.push(span); continue; }
    const start = span.end - span.text.length;
    let offset = 0;
    for (const match of span.text.matchAll(/\\"[\s\S]*?\\"/g)) {
      const at = start + match.index!;
      if (protectedRanges.some(range => at >= range.start && at < range.end)) continue;
      if (match.index! > offset) spans.push({ kind: "text", text: span.text.slice(offset, match.index), end: at });
      offset = match.index! + match[0].length;
      spans.push({ kind: "dialogue", text: match[0], end: start + offset });
    }
    if (offset < span.text.length) spans.push({ kind: "text", text: span.text.slice(offset), end: span.end });
  }
  return spans;
}
