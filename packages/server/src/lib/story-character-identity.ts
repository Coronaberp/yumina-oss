import { characterIdentifiers, displayCharacterName } from "@yumina/engine";

type CharacterSource = { id: string; name: string; content: string };
export interface CharacterIdentity {
  id: string;
  name: string;
  aliases: string[];
  facts: string;
  searchText: string;
  structured: boolean;
}

/** Exact author text, never a model-generated summary. Freeform cards keep
 * their biography when that specific character is needed. */
export function characterIdentity(entry: CharacterSource, castNames: string[] = [entry.name]): CharacterIdentity {
  const name = displayCharacterName(entry.name);
  const fields: Array<{ label: string; value: string }> = [];
  for (const line of (entry.content ?? "").split(/\r?\n/)) {
    const plain = line.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/, "");
    const match = plain.match(/^\s*(Full Name|Name|Age|Apparent Age|Species|Race|Occupation|Role|Aliases?)\s*:\s*(.+)$/i);
    if (match) fields.push({ label: match[1]!, value: match[2]!.trim() });
  }
  const identifiers = characterIdentifiers(castNames.map(displayCharacterName));
  const aliases = [...new Set(identifiers.filter(e => e.name === name).map(e => e.identifier))];
  const facts = fields.length ? fields.map(f => `${f.label}: ${f.value}`).join("\n") : entry.content ?? "";
  // Positive identity fields supplement dense retrieval. Negative commentary
  // about somebody else's profession must not become this actor's role.
  const positive = (text: string) => text.split(/(?<=[.!?])\s+|\b(?:not|never|isn't|is not|doesn't|does not)\b/i)[0] ?? "";
  const searchText = fields.filter(f => /^(species|race|occupation|role)$/i.test(f.label)).map(f => positive(f.value)).join(" ");
  return { id: entry.id, name, aliases, facts, searchText, structured: fields.length > 0 };
}

const STOP = new Set("a an the to of and or at in on with who whom is are was were be being been i you he she they it his her their this that these those for from about speak talk ask meet find observe look academy year old first human character person people student staff".split(" "));
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2 && !STOP.has(w));

/** BM25 over positive authored identity fields. Returned IDs supplement,
 * rather than replace, semantic candidates. No biography reaches an LLM here. */
export function identityRoleMatches<T extends CharacterSource>(entries: readonly T[], query: string): T[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || explicitlyEmptyCharacterScene(query)) return [];
  const documents = entries.map(e => words(characterIdentity(e).searchText));
  const average = documents.reduce((n, d) => n + d.length, 0) / Math.max(1, documents.length) || 1;
  const df = new Map(terms.map(t => [t, documents.filter(d => d.includes(t)).length]));
  const ranked = entries.map((entry, i) => {
    const doc = documents[i]!;
    let score = 0, matches = 0;
    for (const term of terms) {
      const tf = doc.filter(w => w === term).length;
      if (!tf) continue;
      matches++;
      const idf = Math.log(1 + (entries.length - df.get(term)! + .5) / (df.get(term)! + .5));
      score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * doc.length / average));
    }
    return { entry, score, matches };
  }).filter(e => e.matches > 0).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  // Keep ties when the role really is ambiguous; cap optional role matches.
  return top ? ranked.filter(e => e.score >= top.score * .65).slice(0, 4).map(e => e.entry) : [];
}

export function explicitlyEmptyCharacterScene(query: string): boolean {
  return /\b(?:no (?:characters|people|one|other people)(?:\b|\s)|(?:alone|empty) (?:room|storeroom|hallway)|without (?:any )?(?:characters|people))\b/i.test(query);
}

/** A broad crowd/location query cannot identify its next actor. The draft
 * guard supplies that actor's profile once the model introduces them. */
export function requestsCharacterLookup(query: string): boolean {
  if (explicitlyEmptyCharacterScene(query)) return false;
  // Only recognized scene-only requests suppress optional character discovery.
  // Missing English cue words never exclude freeform or non-English profiles.
  return !(/\b(?:crowd|back row|look around)\b/i.test(query) && !/\b(?:speak|talk|ask|meet|approach|instructor|teacher|professor|librarian|who)\b/i.test(query));
}
