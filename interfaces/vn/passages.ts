import { stripAngleMarkup } from "./angle-markup";
import { splitSpeakerSections } from "./speaker";
import { displayCharacterName, canonicalCharacterName, parseLeadingSpeakerTag } from "./speaker-tag";
import { dialogueSpans, plainDialogue } from "./dialogue-spans";
import { extractResponseChoices, normalizeChoices } from "./choices";
import { stripGameStateDump, stripVariableUpdateTags } from "./metadata";
import { normalizeSpriteExpression } from "./expressions";
import { stripZeroWidthSpaces } from "./text-normalization";
import { standardizeSpeakerMarkup } from "./presentation-markup";
import { isPresentationLiteral, presentationLiteralRanges } from "./presentation-literals";

function character(entries, name) {
  const characters = (entries || []).filter(e => e.role === "character" && e.enabled !== false);
  const canonical = canonicalCharacterName(characters.map(e => displayCharacterName(e.name)), displayCharacterName(name));
  return characters.find(e => displayCharacterName(e.name) === canonical);
}

function pages(text) {
  const result = [];
  while (text.length > 280) {
    const prefix = text.slice(0, 280);
    const sentence = [...prefix.matchAll(/[.!?。！？](?:[”’"])?\s+/g)].at(-1);
    const split = sentence && sentence.index > 100 ? sentence.index + sentence[0].length : prefix.lastIndexOf(" ");
    if (split <= 0) break;
    result.push(text.slice(0, split).trim()); text = text.slice(split).trim();
  }
  if (text) result.push(text);
  return result;
}

/** Explicit VN markers carry the speaker/expression until the next marker.
 * Actions always produce their own narrator passage. Legacy labels still work. */
export function passages(entries, content, rawContent = content, player = null) {
  if (!content) return [];
  const names = (entries || []).filter(entry => entry.role === "character" && entry.enabled !== false).map(entry => displayCharacterName(entry.name));
  content = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(content))), names);
  rawContent = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(rawContent))), names);
  content = stripVariableUpdateTags(stripGameStateDump(extractResponseChoices(content).text));
  const legacy = parseLeadingSpeakerTag(rawContent);
  content = parseLeadingSpeakerTag(content).text;
  const candidateLeading = /^\s*\[\s*(?:SPEAKER|Name)\s*:\s*([^:\]\n]+)\s*:\s*([^\]\n]+)\]/i.exec(rawContent);
  const leading = candidateLeading && !isPresentationLiteral(presentationLiteralRanges(rawContent), rawContent.indexOf("[")) ? candidateLeading : null;
  const initialFields = leading?.[2]?.split(":").map(field => field.trim()) || [];
  let name = legacy.speaker || leading?.[1]?.trim() || "", emotion = normalizeSpriteExpression(initialFields[0]), scene = "", offset = 0, explicit = !!leading,
    npcGender = name.toLowerCase() === "npc" && /^(male|female)$/i.test(initialFields[1] || "") ? initialFields[1].toLowerCase() : "";
  let npcId = npcGender ? initialFields.slice(2).join(":").toLowerCase() || "unknown" : "";
  const chunks = [];
  const literals = dialogueSpans(content).filter(span => span.kind === "literal" || span.kind === "dialogue");
  const protectedRanges = presentationLiteralRanges(content);
  const opaque = [...content.matchAll(/!?\[[^\]\n]*\]\([^()\n]*\)|<[^>\n]*>/g)];
  // Some providers emit an invisible separator before the marker keyword.
  // Accept it as padding without changing names, prose, quotes or code.
  const marker = /\[[\s\u200B\u2060]*(SPEAKER|Name)\s*:\s*([^:\]\n]+)\s*:\s*([^\]\n]+)\]|\[[\s\u200B\u2060]*SCENE\s*:\s*([^\]\n]+)\]/gi;
  for (const match of content.matchAll(marker)) {
    if (isPresentationLiteral(protectedRanges, match.index)) continue;
    if (literals.some(span => match.index >= span.end - span.text.length && match.index < span.end)) continue;
    if (opaque.some(span => match.index >= span.index && match.index < span.index + span[0].length)) continue;
    chunks.push({ text: content.slice(offset, match.index), name, emotion, scene, explicit, npcGender, npcId });
    if (match[4]) scene = match[4].trim();
    else {
      name = match[2].trim();
      const fields = match[3].split(":").map(field => field.trim());
      emotion = normalizeSpriteExpression(fields[0]); explicit = true;
      npcGender = name.toLowerCase() === "npc" && /^(male|female)$/i.test(fields[1] || "") ? fields[1].toLowerCase() : "";
      npcId = npcGender ? fields.slice(2).join(":").toLowerCase() || "unknown" : "";
    }
    offset = match.index + match[0].length;
  }
  chunks.push({ text: content.slice(offset), name, emotion, scene, explicit, npcGender, npcId });
  const playerSpeaker = name => /^(?:\{\{user\}\}|you|user|player)$/i.test(name || "") || !!player?.name && String(name).toLocaleLowerCase() === player.name.toLocaleLowerCase() && !character(entries, name);
  return chunks.flatMap(chunk => {
    const declared = character(entries, chunk.name);
    const known = declared || (playerSpeaker(chunk.name) ? { name: chunk.name, role: "character", enabled: true, portrait: player?.avatar || null } : null);
    // An explicit marker can identify an incidental NPC without a stored
    // character entry. Register it only for this marked passage.
    const explicitSpeaker = chunk.explicit && chunk.name.toLowerCase() !== "narrator"
      ? { name: chunk.name, role: "character", enabled: true, portrait: null } : null;
    const tagged = known || explicitSpeaker;
    const speakerEntries = known && !declared ? [...(entries || []), known] : !known && explicitSpeaker ? [...(entries || []), explicitSpeaker] : entries;
    const tag = chunk.name ? `[speaker: ${tagged ? displayCharacterName(tagged.name) : "narrator"}]` : "";
    const chunkHasQuotes = dialogueSpans(chunk.text).some(span => span.kind === "dialogue");
    return splitSpeakerSections(speakerEntries, chunk.text, tag + chunk.text, chunk.explicit).flatMap(section => {
      const spans = dialogueSpans(section.content);
      const hasQuotes = spans.some(span => span.kind === "dialogue");
      return spans.flatMap(span => {
        let text = span.text.trim();
        if (!text) return [];
        const narratorLabel = /^\s*(?:\*{1,2}|_{1,2})?Narrator(?:\*{1,2}|_{1,2})?\s*:/i.test(section.text) ||
          (chunk.explicit && chunk.name.toLowerCase() === "narrator" && !section.speaker);
        const spoken = !narratorLabel && (span.kind === "dialogue" || (span.kind === "text" && !hasQuotes && !!(section.speaker || (!chunkHasQuotes && chunk.explicit && tagged))));
        const speaker = spoken ? section.speaker || tagged : null;
        if (span.kind === "dialogue") text = plainDialogue(text).replace(/^(["'“‘«「『])([\s\S]*?)["'”’»」』]$/, "$2");
        if (span.kind === "action") text = text.replace(/^(\*{1,3}|_{1,3})([\s\S]*?)\1$/, "$2").replace(/^(?:\*{1,3}|_{1,3})/, "");
        const kind = spoken ? "dialogue" : "narration";
        const isPlayer = spoken && !!speaker && playerSpeaker(speaker.name);
        const definedSpeaker = spoken && speaker && !isPlayer ? character(entries, speaker.name) : null;
        return pages(text).map(text => ({ name: isPlayer ? player?.name ? `${player.name} (You)` : "You" : spoken ? definedSpeaker ? displayCharacterName(definedSpeaker.name) : "NPC" : "", portrait: isPlayer ? player?.avatar || null : definedSpeaker?.portrait || null,
          ...(isPlayer ? { player: true } : {}),
          ...(!spoken && declared && chunk.explicit && span.kind !== "literal" ? { stageName: displayCharacterName(declared.name) } : {}),
          emotion: chunk.emotion, scene: chunk.scene, kind, text,
          ...(spoken && !definedSpeaker && chunk.npcGender ? { npcGender: chunk.npcGender, npcId: chunk.npcId } : {}) }));
      });
    });
  });
}

export function messagePassages(api, message) {
  const swipe = message.swipes?.[message.activeSwipeIndex || 0];
  return passages(api.entries, message.content || "", swipe?.rawContent || message.content, api.user);
}

/** A submitted choice has no implicit speaker tag: unquoted player actions
 * are narration, and only quoted speech is attributed to the persona. */
export function playerChoicePassages(text, player = null, emotion = "normal") {
  const spans = dialogueSpans(stripZeroWidthSpaces(text || "")).flatMap(span => {
    if (span.kind !== "action") return [span];
    const inner = span.text.replace(/^(\*{1,3}|_{1,3})([\s\S]*?)\1$/, "$2").replace(/^(?:\*{1,3}|_{1,3})/, "");
    return dialogueSpans(inner).map(part => ({ ...part, kind: part.kind === "dialogue" ? "dialogue" : "action" }));
  });
  return spans.flatMap(span => {
    const spoken = span.kind === "dialogue";
    const content = (spoken ? plainDialogue(span.text).replace(/^(["'“‘«「『])([\s\S]*?)["'”’»」』]$/, "$2") : span.text).trim();
    return pages(content).map(text => ({ text, kind: spoken ? "dialogue" : "narration", name: spoken ? player?.name ? `${player.name} (You)` : "You" : "",
      portrait: spoken ? player?.avatar || null : null, ...(spoken ? { player: true } : {}), emotion, scene: "" }));
  });
}

export function messageChoices(message) {
  if (!message || message.role !== "assistant") return [];
  const swipe = message.swipes?.[message.activeSwipeIndex || 0];
  const choices = normalizeChoices(swipe?.choices);
  if (choices?.length) return choices;
  for (const text of [swipe?.rawContent, swipe?.content, message.content]) {
    const parsed = extractResponseChoices(text || "").choices;
    if (parsed !== undefined) return parsed;
  }
  return [];
}

export function segmentPassages(api) {
  try {
    const raw = api.variables?.segments;
    const segments = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(segments)) return [];
    return segments.flatMap(segment => {
      if (!segment || typeof segment.text !== "string") return [];
      const speaker = typeof segment.speaker === "string" ? segment.speaker.trim() : "";
      const entry = character(api.entries, speaker);
      const isPlayer = /^(?:\{\{user\}\}|you|user|player)$/i.test(speaker) || !!api.user?.name && speaker.toLocaleLowerCase() === api.user.name.toLocaleLowerCase() && !entry;
      const name = isPlayer ? "{{user}}" : entry ? displayCharacterName(entry.name) : speaker && speaker.toLowerCase() !== "narrator" ? "NPC" : "Narrator";
      const gender = typeof segment.gender === "string" && /^(male|female)$/i.test(segment.gender.trim()) ? segment.gender.trim().toLowerCase() : "";
      const id = typeof segment.npcId === "string" ? segment.npcId.replace(/[\]\r\n]/g, "").trim() : "unknown";
      const metadata = !entry && name === "NPC" && gender ? `:${gender}:${id || "unknown"}` : "";
      const markup = `[SPEAKER:${name}:${normalizeSpriteExpression(segment.emotion)}${metadata}] ${segment.text}`;
      return passages(api.entries, markup, markup, api.user);
    });
  } catch { return []; }
}
