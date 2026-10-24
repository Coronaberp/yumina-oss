import { messagePassages } from "./passages";
import { presentationLiteralRanges } from "./presentation-literals";

const keyFor = line => line.kind === "dialogue" && line.name === "NPC" && !line.player
  && /^(male|female)$/.test(line.npcGender || "") && typeof line.npcId === "string"
  && line.npcId.trim() && line.npcId.toLowerCase() !== "unknown"
  ? `${line.npcGender}:${line.npcId}` : null;

const selectedContentMatches = message => !Array.isArray(message?.swipes) || !message.swipes.length
  || typeof message.swipes[message.activeSwipeIndex || 0]?.content === "string"
    && message.swipes[message.activeSwipeIndex || 0].content === message.content;

function disclosedName(text, previous = "") {
  const shown = text.trim(), names = [];
  // Dialogue pages can split a nested quotation. Keep its already displayed
  // context so a continuation never turns reported speech into an introduction.
  let prose = previous + shown;
  for (const range of presentationLiteralRanges(prose)) prose = prose.slice(0, range.start) + " ".repeat(range.end - range.start) + prose.slice(range.end);
  const current = prose.slice(previous.length);
  // Retain the original explicit introduction forms.
  const prefix = /^(?:my name is|call me)\s+/i.exec(current);
  if (prefix) {
    if ([...current.matchAll(/\b(?:my name is|call me)\s+/gi)].length !== 1) return "";
    const name = /^([\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*){0,3})(?=[.!,:;]|$)/u.exec(current.slice(prefix[0].length));
    if (name) names.push(name[1]);
  }
  // A direct sentence can introduce the speaker mid-utterance. Ignore quoted
  // reports and examples; HTML-bearing prose remains deliberately conservative.
  if (!/[<>]/.test(previous + shown)) {
    for (const match of prose.matchAll(/(?:^|[.!?]\s+)I(?:['’]m| am)\s+/g)) {
      if (match.index + match[0].length < previous.length) continue;
      const name = /^([\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*){0,3})\.(?=\s|$)/u.exec(prose.slice(match.index + match[0].length));
      if (name) names.push(name[1]);
    }
  }
  return names.length > 1 ? "" : names[0] || null;
}

/** Read-only display aliases, earned after the introduction page. Recompute
 * from the selected history/prefix so rewinds and branch changes forget them.
 * Never replace canonical names, stable NPC IDs, sprite keys or stat ownership. */
export function npcSpeakerLabels(api, message, lines) {
  const defaults = lines.map(line => line.name || (line.kind === "dialogue" ? "NPC" : ""));
  if (!lines.some(keyFor) || !selectedContentMatches(message)) return defaults;
  const names = new Map();
  let previousKey = null, previousText = "";
  const learn = line => {
    const key = keyFor(line), text = line.text || "";
    const name = key && disclosedName(text, key === previousKey ? previousText : "");
    previousText = key ? (key === previousKey ? previousText : "") + text.trim() + "\n" : "";
    previousKey = key;
    if (!key || name === null) return;
    if (!names.has(key)) names.set(key, new Set());
    names.get(key).add(name);
  };
  const messages = api.messages || [], at = message?.id ? messages.findIndex(item => item.id === message.id) : -1;
  for (const prior of messages.slice(0, Math.max(0, at))) {
    if (prior.role !== "assistant" || prior.status === "failed" || !selectedContentMatches(prior) || !/\b(?:my name is|call me|I['’]m|I am)\s+/i.test(prior.content || "")) continue;
    // The active displayed content is authoritative; raw/inactive swipes never
    // supply an introduction, even if they contain additional speaker metadata.
    previousKey = null; previousText = "";
    for (const line of messagePassages(api, { content: prior.content })) learn(line);
  }
  previousKey = null; previousText = "";
  return lines.map((line, index) => {
    const known = names.get(keyFor(line));
    const label = known?.size === 1 ? [...known][0] : "";
    learn(line);
    return label || defaults[index];
  });
}
