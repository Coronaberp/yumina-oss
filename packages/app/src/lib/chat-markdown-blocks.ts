import { Lexer } from "marked";

const containers = new Set(["heading", "list", "blockquote", "table", "code", "hr"]);

/** Block Markdown owns its quoted/italic contents. A table cell, list item
 * or quoted example must not be cut into separate dialogue bubbles. */
export function hasMarkdownBlockStructure(source: string): boolean {
  const tokens = Lexer.lex(source, { gfm: true });
  return Object.keys(tokens.links).length > 0 || tokens.some(token => containers.has(token.type));
}
