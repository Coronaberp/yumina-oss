export const NARRATOR_SPEAKER = "narrator";
const LEADING_SPEAKER_TAG = /^\s*\[\s*speaker\s*:\s*([^:\]\n]*?)\s*\]/i;
export function displayCharacterName(raw: string): string {
  const trimmed = raw.trim();
  const m = /^[^:：]{1,12}[:：]\s*(.+)$/s.exec(trimmed);
  return m && m[1]!.trim() ? m[1]!.trim() : trimmed;
}

/** Short names, name parts and parenthetical aliases are accepted only when
 * they identify one character. Canonical names remain the portrait and sprite keys. */
export function characterIdentifiers(names: ReadonlyArray<string>) {
  const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
  const records = [...new Set(names)].map(name => {
    const qualifier = /\s*\(([^()]+)\)\s*$/.exec(name);
    const base = name.replace(/\s*\([^()]+\)\s*$/, "").trim();
    const aliases = [...new Set([base, ...base.split(/\s+/), ...(qualifier ? [qualifier[1]!.trim(), ...qualifier[1]!.trim().split(/\s+/)] : [])])];
    return { name, aliases: aliases.filter(alias => alias && normalize(alias) !== normalize(name)) };
  });
  const owners = new Map<string, Set<string>>();
  for (const { name, aliases } of records) {
    for (const identifier of [name, ...aliases]) {
      const key = normalize(identifier);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(name);
    }
  }
  return records.flatMap(({ name, aliases }) => [{ name, identifier: name }, ...aliases.filter(alias => owners.get(normalize(alias))!.size === 1).map(identifier => ({ name, identifier }))]);
}

export function canonicalCharacterName(names: ReadonlyArray<string>, name: string) {
  const normalize = value => value.trim().replace(/\s+/g, " ").toLowerCase();
  return characterIdentifiers(names).find(candidate => normalize(candidate.identifier) === normalize(name))?.name || null;
}

export interface SpeakerTagParse {
  /** The tagged name, or null when the reply carried no tag. `"narrator"`
   *  is returned as-is (lower-cased) so callers can treat it explicitly. */
  speaker: string | null;
  /** The text with the leading tag removed. */
  text: string;
}

export function parseLeadingSpeakerTag(text: string): SpeakerTagParse {
  const m = LEADING_SPEAKER_TAG.exec(text);
  if (!m) return { speaker: null, text };
  const raw = m[1]!.trim();
  const speaker = raw.toLowerCase() === NARRATOR_SPEAKER ? NARRATOR_SPEAKER : raw;
  return { speaker: speaker || null, text: text.slice(m[0].length).replace(/^[ \t]*\n/, "") };
}

/** True while a stream is still inside a partial leading tag (`[spea`,
 *  `[speaker: Mi`), so the UI can hold the label instead of flashing it. */
export function isPartialLeadingSpeakerTag(text: string): boolean {
  const head = text.trimStart();
  if (!head.startsWith("[")) return false;
  if (head.includes("]")) return false;
  return /^\[\s*(s(p(e(a(k(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(head);
}
