import { canonicalCharacterName, characterIdentifiers, displayCharacterName } from "@yumina/engine";

type CharacterEntry = { id: string; name: string; role?: string; enabled?: boolean };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Historical evidence is a real speaker/presence marker or a line-start
 * speaker label. Prose mentions, quoted rumors, code and unused swipes are not
 * encounters. Current-turn page visibility is handled by the VN reader. */
export function historicalCharacterEncounters(entries: CharacterEntry[], text: string): string[] {
  const characters = entries.filter(entry => entry.role === "character" && entry.enabled !== false);
  const names = characters.map(entry => displayCharacterName(entry.name));
  const content = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, "");
  const found = new Set<string>();
  for (const match of content.matchAll(/(?:^|\n)[ \t]*\[\s*(?:speaker|name)\s*:\s*([^:\]\n]+)(?::[^\]\n]*)?\]/gi)) {
    const canonical = canonicalCharacterName(names, displayCharacterName(match[1]!));
    const entry = characters.find(entry => displayCharacterName(entry.name) === canonical);
    if (entry) found.add(entry.id);
  }
  for (const identity of characterIdentifiers(names)) {
    if (!new RegExp(`(?:^|\\n)[ \\t]*(?:\\*\\*)?${escaped(identity.identifier)}(?:\\*\\*)?[ \\t]*[:：][ \\t]*\\S`, "iu").test(content)) continue;
    const entry = characters.find(entry => displayCharacterName(entry.name) === identity.name);
    if (entry) found.add(entry.id);
  }
  return [...found];
}
