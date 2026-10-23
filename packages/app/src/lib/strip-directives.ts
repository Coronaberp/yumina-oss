/**
 * Strips state-change directives from streaming text so they are never visible to the user.
 * Uses the same patterns as the engine's ResponseParser.
 */
import { isPartialLeadingSpeakerTag, parseLeadingSpeakerTag, stripAngleMarkup, stripAngleVariableDirectives, stripVariableUpdateTags } from "@yumina/engine";

// [variableId: operation value]
const STANDARD = /\[([\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*):\s*(set|add|subtract|multiply|toggle|append|merge|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[\w\p{L}\p{N}.$-]+)?\]/gu;
// Compatibility with the malformed wrapper some models emit: [var: id op value].
const VAR_WRAPPER = /\[\s*var:\s*[\w\p{L}\p{N}.$-]+\s+(?:set|add|subtract|multiply|append|toggle|\+|-|\*)\s*(?:"(?:[^"\\]|\\.)*"|[^\]"]+)?\s*\]/giu;
// [audio: trackId action ...]
const AUDIO = /\[audio:\s*([\w\p{L}\p{N}-]+)\s+(play|stop|crossfade|volume)(?:\s+([\d.]+))?(?:\s+chain:([\w\p{L}\p{N}-]+))?\]/gu;
// [variableId: op {json}] or [variableId: op [json]]
const JSON_DIR = /\[([\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*):\s*(set|merge|push|delete)\s+(\{[\s\S]*?\}|\[[\s\S]*?\])\]/gu;
// <UpdateVariable>...<JSONPatch>...</JSONPatch>...</UpdateVariable>
const UPDATE_VAR = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi;
// Standalone structural XML tags
const STRUCTURAL_XML = /^\s*<\/?(maintext|option|sum|Analysis|UpdateVariable|JSONPatch|status_current_variable)\s*>\s*$/gim;
// Trailing incomplete directive at end of streaming text: [word: ...
const TRAILING_INCOMPLETE = /\[[\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*:[^\]]*$/u;

export function stripDirectives(text: string, declaredVariables: readonly string[] = []): string {
  const clean = stripVariableUpdateTags(stripAngleVariableDirectives(text, declaredVariables, true))
    .replace(UPDATE_VAR, "")
    .replace(AUDIO, "")
    .replace(JSON_DIR, "")
    .replace(VAR_WRAPPER, "")
    .replace(STANDARD, "")
    .replace(STRUCTURAL_XML, "")
    .replace(TRAILING_INCOMPLETE, "");
  return stripAngleMarkup(clean, true);
}

/**
 * The stripper for text pushed to the sandbox while streaming. The leading
 * `[speaker: Name]` tag is NOT a state directive — it tells the bubble whose
 * face to show, and it only has value while the reply is still arriving — so
 * it is kept (normalized to its own line) and everything after it is stripped
 * as usual. A partially streamed tag (`[spea`) is held verbatim: the sandbox
 * hides it, and stripping it here would leave the bubble unable to tell "no
 * tag" from "tag not finished yet".
 */
export function stripDirectivesForSandbox(text: string, declaredVariables: readonly string[] = []): string {
  if (isPartialLeadingSpeakerTag(text)) return text;
  const tag = parseLeadingSpeakerTag(text);
  const rest = stripDirectives(tag.text, declaredVariables);
  return tag.speaker ? `[speaker: ${tag.speaker}]
${rest}` : rest;
}
