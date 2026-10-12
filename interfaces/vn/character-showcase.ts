export const characterShowcase = {
  "css": "",
  "characters": {}
};

export function showcaseStylesFor(characterId) {
  const shared = characterShowcase.css;
  const specific = Object.hasOwn(characterShowcase.characters, characterId) ? characterShowcase.characters[characterId] : "";
  if (!shared && !specific) return "";
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(shared + "\n" + specific);
    const rules = Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
    return "@scope (.vn-character-card) {" + rules + "}";
  } catch { return ""; }
}
