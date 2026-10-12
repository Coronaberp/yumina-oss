/** Literal examples are prose, never instructions, choices or gameplay writes. */
export interface LiteralRange { start: number; end: number }

const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "「": "」", "『": "』" };
const word = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);

/** A clearly started next speech passage recovers an unfinished old quote.
 * Balanced multiline examples with an unquoted marker body remain literal. */
export function presentationQuoteEnd(text: string, start: number): number {
  const opener = text[start]!, closing = pairs[opener];
  if (!closing) return start + 1;
  for (let end = start + 1; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (text[end] === closing && !((closing === "'" || closing === "’") && word(text[end - 1]) && word(text[end + 1]))) return end + 1;
    if (text[end] === "\n") {
      const next = /^\n[\t ]*\[\s*(?:SPEAKER|Name)\s*:[^\]\n]+\][\t ]*/i.exec(text.slice(end));
      if (next && text[end + next[0].length] === opener) return end;
    }
  }
  const boundary = /\n[\t ]*\[\s*(?:SPEAKER|Name|SCENE|CHOICES|CHOCIES)\s*:/i.exec(text.slice(start + 1));
  return boundary ? start + 1 + boundary.index : text.length;
}

export function presentationLiteralRanges(text: string): LiteralRange[] {
  const ranges: LiteralRange[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if ((i === 0 || text[i - 1] === "\n") && /^(?: {4}|\t)\S/.test(rest)) {
      const block = /^(?:(?: {4}|\t)[^\n]*(?:\n|$))+/u.exec(rest)![0];
      ranges.push({ start: i, end: i + block.length }); i += block.length; continue;
    }
    const fence = (i === 0 || text[i - 1] === "\n") && /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[\\t ]*\\r?$`, "gm");
      close.lastIndex = i + fence[0].length;
      const match = close.exec(text);
      const end = match ? match.index + match[0].length : text.length;
      ranges.push({ start: i, end }); i = end; continue;
    }
    let linkLength = 0;
    if (/^!?\[/.test(rest)) {
      let depth = 0, cursor = i + (text[i] === "!" ? 1 : 0);
      for (; cursor < text.length && text[cursor] !== "\n"; cursor++) {
        if (text[cursor] === "\\") { cursor++; continue; }
        if (text[cursor] === "[") depth++;
        if (text[cursor] === "]" && --depth === 0) { cursor++; break; }
      }
      if (!depth && text[cursor] === "(") {
        let parentheses = 1;
        for (cursor++; cursor < text.length && text[cursor] !== "\n"; cursor++) {
          if (text[cursor] === "\\") { cursor++; continue; }
          if (text[cursor] === "(") parentheses++;
          if (text[cursor] === ")" && --parentheses === 0) { linkLength = cursor + 1 - i; break; }
        }
      }
    }
    const html = /^<(code|pre)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/i.exec(rest);
    if (linkLength || html) {
      const end = i + (linkLength || html![0].length);
      ranges.push({ start: i, end }); i = end; continue;
    }
    if (text[i] === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const close = text.indexOf(ticks, i + ticks.length);
      const end = close < 0 ? text.length : close + ticks.length;
      ranges.push({ start: i, end }); i = end; continue;
    }
    if (text[i] === "\\" && i + 1 < text.length) {
      ranges.push({ start: i, end: i + 2 }); i += 2; continue;
    }
    const closing = pairs[text[i]!];
    if (closing && !((text[i] === "'" || text[i] === "‘") && (word(text[i - 1]) || /\{\{(?:user|char)\}\}$/i.test(text.slice(0, i))))) {
      const start = i;
      i = presentationQuoteEnd(text, start);
      ranges.push({ start, end: Math.min(i, text.length) }); continue;
    }
    // Quotes inside an actual bracketed control are JSON payload, not a prose
    // quote. Leave the complete payload available to its existing validator.
    if (/^\[\s*[\w\p{L}\p{N}.$-]+(?:\[\d+\][\w\p{L}\p{N}.$-]*)*\s*:/u.test(rest)) {
      let depth = 0, quoted = false, end = i;
      for (; end < text.length; end++) {
        const char = text[end];
        if (quoted) { if (char === "\\") end++; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === "[") depth++;
        else if (char === "]" && --depth === 0) { end++; break; }
        else if (char === "\n" && depth === 1) break;
      }
      i = Math.max(i + 1, end); continue;
    }
    i++;
  }
  return ranges;
}

export function isPresentationLiteral(ranges: readonly LiteralRange[], offset: number): boolean {
  return ranges.some(range => offset >= range.start && offset < range.end);
}

/** Only the existing explicit JSON command compatibility format is active.
 * A code/example container around it always takes precedence. */
export function isActiveDirectiveFence(text: string, offset: number): boolean {
  if (!/^```[\t ]*(?:json)?[\t ]*\r?\n/i.test(text.slice(offset))) return false;
  if (presentationLiteralRanges(text).some(range => offset > range.start && offset < range.end)) return false;
  const previous = text.slice(0, offset).trimEnd().split("\n").at(-1) || "";
  return !/\b(?:example|sample|literal|syntax|illustration)\s*:\s*$/i.test(previous);
}

/** Mask before existing syntax adapters, then restore the exact original bytes. */
export function maskPresentationLiterals(text: string): { text: string; restore: (value: string) => string } {
  let prefix = "\u0000YUMINA_LITERAL_";
  while (text.includes(prefix)) prefix += "_";
  const literals: string[] = [];
  let output = "", cursor = 0;
  for (const range of presentationLiteralRanges(text)) {
    output += text.slice(cursor, range.start) + `${prefix}${literals.push(text.slice(range.start, range.end)) - 1}\u0000`;
    cursor = range.end;
  }
  return { text: output + text.slice(cursor), restore: value => {
    for (let i = 0; i < literals.length; i++) value = value.replaceAll(`${prefix}${i}\u0000`, literals[i]!);
    return value;
  } };
}
