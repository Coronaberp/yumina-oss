import type { RootComponent, WorldEntry } from "../types/index.js";

export const CHARACTER_SHOWCASE_FILE = "character-showcase.ts";
export const CHARACTER_SHOWCASE_CSS_LIMIT = 30_000;
export type CharacterShowcase = { css: string; characters: Record<string, string> };

export function isShowcaseCharacter(entry: Pick<WorldEntry, "role" | "tags">): boolean {
  return entry.role === "character" || !!entry.tags?.some(tag => /^characters?$/i.test(tag.trim()));
}

const invalid = () => new Error("Character showcase settings must use an exported JSON object literal. Edit the current character-showcase.ts settings without executable expressions.");

/** Locate a JSON literal without evaluating any creator-authored JavaScript. */
function literal(source: string) {
  const matches = [...source.matchAll(/^[ \t]*export\s+const\s+characterShowcase\s*=\s*/gm)];
  if (matches.length !== 1) throw invalid();
  const start = matches[0]!.index! + matches[0]![0].length;
  if (source[start] !== "{") throw invalid();
  let depth = 0, quoted = false, escaped = false;
  for (let cursor = start; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const end = cursor + 1;
      if (!/^\s*;/.test(source.slice(end))) throw invalid();
      try { return { value: JSON.parse(source.slice(start, end)) as unknown, start, end }; }
      catch { throw invalid(); }
    }
  }
  throw invalid();
}

function checkCss(css: unknown): asserts css is string {
  if (typeof css !== "string") throw new Error("Showcase CSS must be a string.");
  if (css.length > CHARACTER_SHOWCASE_CSS_LIMIT) throw new Error("Showcase CSS is limited to 30,000 characters per setting.");
}

export function readCharacterShowcase(source?: string): CharacterShowcase {
  if (source === undefined) return { css: "", characters: {} };
  const { value } = literal(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => key !== "css" && key !== "characters")) throw invalid();
  checkCss(config.css);
  if (!config.characters || typeof config.characters !== "object" || Array.isArray(config.characters)) throw invalid();
  for (const css of Object.values(config.characters)) checkCss(css);
  return { css: config.css, characters: { ...config.characters as Record<string, string> } };
}

// The browser parses and balances each rule before the stylesheet is scoped.
// Creator selectors cannot escape the card through an unmatched closing brace.
export const CHARACTER_SHOWCASE_RUNTIME = `
export function showcaseStylesFor(characterId) {
  const shared = characterShowcase.css;
  const specific = Object.hasOwn(characterShowcase.characters, characterId) ? characterShowcase.characters[characterId] : "";
  if (!shared && !specific) return "";
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(shared + "\\n" + specific);
    const rules = Array.from(sheet.cssRules, rule => rule.cssText).join("\\n");
    return "@scope (.vn-character-card) {" + rules + "}";
  } catch { return ""; }
}
`;

export function writeCharacterShowcaseCss(root: RootComponent, entries: ReadonlyArray<WorldEntry>, css: string, characterId?: string): RootComponent {
  checkCss(css);
  if (characterId !== undefined && !entries.some(entry => entry.id === characterId && isShowcaseCharacter(entry))) {
    throw new Error("Choose an existing character entry ID for this showcase override.");
  }
  const files = { ...root.files };
  let viewer = files["character-viewer.tsx"];
  if (!viewer || !viewer.includes('<div className="vn-character-card">')) {
    throw new Error("This layout needs a compatible character viewer before showcase CSS can be connected. Preserve its authored UI and add the character viewer first.");
  }
  if (!viewer.includes("showcaseStylesFor(viewer.target.id)")) {
    viewer = 'import { showcaseStylesFor } from "./character-showcase";\n' + viewer.replace('<div className="vn-character-card">', '<style>{showcaseStylesFor(viewer.target.id)}</style>\n    <div className="vn-character-card">');
    files["character-viewer.tsx"] = viewer;
  }
  const source = files[CHARACTER_SHOWCASE_FILE];
  const config = readCharacterShowcase(source);
  if (characterId === undefined) config.css = css;
  else if (css.trim()) Object.defineProperty(config.characters, characterId, { value: css, enumerable: true, configurable: true, writable: true });
  else delete config.characters[characterId];
  const data = JSON.stringify(config, null, 2);
  if (source !== undefined) {
    const { start, end } = literal(source);
    files[CHARACTER_SHOWCASE_FILE] = source.slice(0, start) + data + source.slice(end);
  } else files[CHARACTER_SHOWCASE_FILE] = `export const characterShowcase = ${data};\n${CHARACTER_SHOWCASE_RUNTIME}`;
  return { ...root, files, compiled: undefined, updatedAt: new Date().toISOString() };
}
