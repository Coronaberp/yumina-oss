import { isPresentationLiteral, presentationLiteralRanges, standardizeSpeakerMarkup } from "@yumina/engine";

export interface SpeakerMarker {
  name: string;
  emotion: string;
  npcGender?: string;
  npcId?: string;
}

export interface MarkedPassage {
  text: string;
  /** Original control bytes, retained for source inspection, never rendered. */
  sourcePrefix: string;
  marker: SpeakerMarker | null;
  scene?: string;
}

const markers = /\[[\s\u200b\u2060]*(?:SPEAKER|Name)\s*:\s*[^:\]\n|]+(?:\s*[:|]\s*[^\]\n]+)?\]|\[[\s\u200b\u2060]*SCENE\s*:\s*([^\]\n]+)\]/gi;

function decodeMarker(source: string, names: readonly string[]): SpeakerMarker | null {
  // Names, expression aliases and NPC fields follow the engine's grammar.
  const canonical = standardizeSpeakerMarkup(source.replace(/[\u200b\u2060]/g, ""), names);
  const match = /^\[SPEAKER:([^:\]\n]+):([^\]\n]+)\]$/i.exec(canonical);
  if (!match) return null;
  const [emotion, gender, ...identity] = match[2]!.split(":");
  return { name: match[1]!, emotion: emotion!, ...(gender ? { npcGender: gender, npcId: identity.join(":") || "unknown" } : {}) };
}

/** Read the engine's explicit presentation controls. Code, quoted examples,
 * links and escaped brackets remain literal; raw prose is never replayed. */
export function markedSpeakerPassages(content: string, names: readonly string[], rawContent: string, streaming: boolean): MarkedPassage[] | null {
  let trimmedPartial = false;
  if (streaming) {
    const start = content.lastIndexOf("[");
    const tail = start >= 0 ? /^([a-z]*)(?:\s*:[^\]\n]*)?$/i.exec(content.slice(start + 1)) : null;
    if (tail && ["speaker", "name", "scene"].some(key => key.startsWith(tail[1]!.toLowerCase())) && !isPresentationLiteral(presentationLiteralRanges(content), start)) {
      content = content.slice(0, start);
      trimmedPartial = true;
    }
  }
  const leading = /^\s*(\[[\s\u200b\u2060]*(?:SPEAKER|Name)\s*:\s*[^:\]\n]+\s*:\s*[^\]\n]+\])/i.exec(rawContent);
  let marker = leading ? decodeMarker(leading[1]!, names) : null;
  let found = !!marker || trimmedPartial;
  let scene: string | undefined;
  let offset = 0;
  let sourcePrefix = "";
  const ranges = presentationLiteralRanges(content);
  const chunks: MarkedPassage[] = [];
  for (const match of content.matchAll(markers)) {
    if (isPresentationLiteral(ranges, match.index!)) continue;
    const next = match[1] ? null : decodeMarker(match[0], names);
    if (!match[1] && !next) continue;
    found = true;
    chunks.push({ text: content.slice(offset, match.index), sourcePrefix, marker, scene });
    if (match[1]) scene = match[1].trim();
    else marker = next;
    offset = match.index! + match[0].length;
    sourcePrefix = match[0];
  }
  if (!found) return null;
  chunks.push({ text: content.slice(offset), sourcePrefix, marker, scene });
  return chunks;
}
