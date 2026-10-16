import { maskPresentationLiterals } from './presentation-literals';

const TAGS = /<!--[\s\S]*?(?:-->|$)|<\s*\/?\s*[A-Za-z_][\w:.-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|<\s*\/?\s*>/g;
const AUTOLINK = /^<\s*(?:[a-z][\w+.-]*:\/\/|mailto:)/i;
const BRACKET_RECEIPT = /\[\s*[\w.-]*state(?=\s+(?:version|status|count)\s*=)/gi;

function stripBracketReceipts(text: string): string {
  let output = '', cursor = 0;
  BRACKET_RECEIPT.lastIndex = 0;
  for (let match; (match = BRACKET_RECEIPT.exec(text));) {
    let depth = 1, end = match.index + 1;
    for (; end < Math.min(text.length, match.index + 4096); end++) {
      if (text[end] === '[') depth++;
      if (text[end] === ']' && --depth === 0) { end++; break; }
    }
    if (depth) continue;
    output += text.slice(cursor, match.index);
    cursor = end; BRACKET_RECEIPT.lastIndex = end;
  }
  return output + text.slice(cursor);
}

/** Display only: remove angle-tag syntax, including unknown/misspelled names.
 * Keep inner prose, Markdown autolinks, comparisons and literal code/examples.
 * Apply gameplay commands before this presentation cleanup. */
export function stripAngleMarkup(text: string, streaming = false): string {
  if (!text.includes('<') && !text.includes('[')) return text;
  const literals = maskPresentationLiterals(text);
  let clean = stripBracketReceipts(literals.text).replace(TAGS, source => AUTOLINK.test(source) ? source : '');
  if (streaming) clean = clean
    .replace(/\[[\w.-]*state(?:\s[^\]\n]*)?$/i, '')
    .replace(/<\s*\/?\s*(?:[A-Za-z_][^<>]*)?$/, source => AUTOLINK.test(source) ? source : '');
  return clean === literals.text ? text : literals.restore(clean);
}
