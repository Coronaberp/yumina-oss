import { stripZeroWidthSpaces } from "./text-normalization.js";
import { isPresentationLiteral, presentationLiteralRanges } from "./presentation-literals.js";

/** Choice labels are presentation metadata, never state-variable writes. */
export function normalizeChoices(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return undefined;
  const playerIdentity = (text: string) => text
    .replace(/\[\s*(?:your|player(?:'s)?)\s+(?:full\s+)?name\s*\]/gi, "{{user}}")
    .replace(/(\b(?:my\s+(?:full\s+)?name\s+is|name['’]s|I\s+am|I['’]m)\s+)\[\s*name\s*\]/gi, "$1{{user}}")
    .replace(/\{\{user\}\}[\t ]+\[\s*(?:(?:your|player(?:'s)?)\s+)?surname\s*\]/gi, "{{user}}");
  return [...new Set(value.map(item => playerIdentity(stripZeroWidthSpaces(item)).trim()).filter(Boolean))].slice(0, 8).map(item => item.slice(0, 500));
}

/** Strict legacy string arrays; never evaluate model text or repair lost words. */
function parseChoiceStrings(payload: string): unknown {
  try { return JSON.parse(payload); } catch { /* Single-quoted legacy strings. */ }
  let i = 0;
  const whitespace = () => { while (/\s/.test(payload[i] || "") && i < payload.length) i++; };
  whitespace();
  if (payload[i++] !== "[") return undefined;
  const values: string[] = [];
  whitespace();
  while (i < payload.length && payload[i] !== "]") {
    const quote = payload[i++];
    if (quote !== "'" && quote !== '"') return undefined;
    let value = "", closed = false;
    while (i < payload.length) {
      const char = payload[i++]!;
      if (char === quote) { closed = true; break; }
      if (char !== "\\") { value += char; continue; }
      const escaped = payload[i++];
      if (escaped === undefined) return undefined;
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
      if (!(escaped in escapes)) return undefined;
      value += escapes[escaped];
    }
    if (!closed) return undefined;
    values.push(value); whitespace();
    if (payload[i] === "]") break;
    if (payload[i++] !== ",") return undefined;
    whitespace();
  }
  if (payload[i++] !== "]") return undefined;
  whitespace();
  return i === payload.length ? values : undefined;
}

function standardizeChoiceWrappers(text: string): string {
  let literals = presentationLiteralRanges(text);
  text = text.replace(/<(choices|options)\s*>\s*([\s\S]*?)\s*<\/\1\s*>/gi, (source, _name: string, payload: string, index: number) => {
    if (isPresentationLiteral(literals, index)) return source;
    const choices = normalizeChoices(parseChoiceStrings(payload));
    return choices ? `[CHOICES:${JSON.stringify(choices)}]` : source;
  });
  literals = presentationLiteralRanges(text);
  return text.replace(/^[\t ]*(?:#{1,6}\s*)?(?:\*\*)?(?:Choices|Options)(?:\*\*)?\s*:?\s*\r?\n((?:[\t ]*(?:\d+[.)]|[-*•])\s+[^\n]+(?:\r?\n|$)){2,8})/gim, (source, list: string, index: number) => {
    if (isPresentationLiteral(literals, index)) return source;
    const choices = normalizeChoices(list.trim().split(/\r?\n/).map(line => line.replace(/^[\t ]*(?:\d+[.)]|[-*•])\s+/, "")));
    return choices ? `[CHOICES:${JSON.stringify(choices)}]\n` : source;
  });
}

export function extractResponseChoices(text: string): { text: string; choices?: string[] } {
  text = standardizeChoiceWrappers(stripZeroWidthSpaces(text));
  const literals = presentationLiteralRanges(text);
  // Accept the observed transposed spelling too; these are presentation tags.
  const pattern = /\[[\s\u200B\u2060]*(?:CHOICES?|CHOCIES|OPTIONS)\s*:\s*(?=\[|["'])/gi;
  let match: RegExpExecArray | null;
  let choices: string[] | undefined;
  let output = "", cursor = 0;
  while ((match = pattern.exec(text))) {
    if (isPresentationLiteral(literals, match.index)) continue;
    const start = pattern.lastIndex;
    // Some providers omit the inner array brackets but still emit a valid
    // comma-separated JSON string list. Recover only that precise format.
    const array = text[start] === "[";
    let depth = array ? 0 : 1, quoted = "", end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (char === "\\") { end++; continue; }
        if (char === quoted) quoted = "";
      } else if (char === '"' || char === "'") quoted = char;
      else if (char === "[") depth++;
      else if (char === "]" && --depth === 0) { end++; break; }
    }
    // The JSON array must close; the tag's extra closing bracket is optional.
    const closing = array ? (/^\s*\]/.exec(text.slice(end))?.[0] ?? "") : depth === 0 ? "" : undefined;
    if (closing === undefined || depth !== 0 || quoted) continue;
    try {
      const payload = array ? text.slice(start, end) : `[${text.slice(start, end - 1)}]`;
      const labels = normalizeChoices(parseChoiceStrings(payload));
      if (!labels) continue;
      choices = labels;
      output += text.slice(cursor, match.index);
      cursor = end + closing.length;
      pattern.lastIndex = cursor;
    } catch { /* Malformed markup remains visible; do not invent choices. */ }
  }
  return { text: output + text.slice(cursor), ...(choices !== undefined ? { choices } : {}) };
}
