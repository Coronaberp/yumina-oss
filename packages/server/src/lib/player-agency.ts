import { extractResponseChoices, maskPresentationLiterals, ResponseParser, ThinkingTagFilter, type ParseResult } from "@yumina/engine";
import { anonymizePlayerPrompt } from "./player-prompt-identity.js";
import { normalizePersonaControlMode } from '@yumina/shared';

const PLAYER = /^(?:\{\{user\}\}|you|user|player)$/i;
const ACTION = /(?:\{\{user\}\}|\byou)\s+(?:(?:is|are|was|were|will|would|has|have|had)\s+)?(?:(?:quietly|silently|suddenly|quickly|slowly|then|finally|hesitantly|instinctively)\s+)*(?:say(?:s)?|said|speak(?:s|ing)?|spoke|ask(?:s|ed)?|reply|replies|replied|answer(?:s|ed)?|whisper(?:s|ed)?|shout(?:s|ed)?|decide(?:s|d)?|choose|chooses|chose|agree(?:s|d)?|refuse(?:s|d)?|accept(?:s|ed)?|think(?:s|ing)?|thought|feel(?:s|ing)?|felt|want(?:s|ed)?|intend(?:s|ed)?|realize(?:s|d)?|remember(?:s|ed)?|know(?:s)?|knew|wonder(?:s|ed)?|walk(?:s|ed)?|step(?:s|ped)?|turn(?:s|ed)?|move(?:s|d)?|run(?:s)?|ran|approach(?:es|ed)?|enter(?:s|ed)?|leave|leaves|left|reach(?:es|ed)?|take|takes|took|grab(?:s|bed)?|raise(?:s|d)?|lift(?:s|ed)?|push(?:es|ed)?|pull(?:s|ed)?|open(?:s|ed)?|close(?:s|d)?|touch(?:es|ed)?|nod(?:s|ded)?|smile(?:s|d)?|laugh(?:s|ed)?|look(?:s|ed)?|glance(?:s|d)?|watch(?:es|ed)?|follow(?:s|ed)?|cast(?:s)?|demonstrate(?:s|d)?|offer(?:s|ed)?|wait(?:s|ed)?|sit(?:s)?|sat|stand(?:s)?|stood|drink(?:s)?|drank|eat(?:s)?|ate|kiss(?:es|ed)?|hug(?:s|ged)?|attack(?:s|ed)?)\b/i;
const PAUSE = "*The scene pauses.*";
// At a clause boundary the player is the grammatical subject, even if the
// model chooses a verb that isn't in ACTION. Passive environmental descriptions
// can still mention the player without making a choice or action for them.
const PLAYER_SUBJECT = /(?:^|[.!?;,—]\s*|\b(?:and|then|while|as)\s+)[\s*_]*(?:\{\{user\}\}|you)\s+([^\n.!?]+)/gi;
const PASSIVE_REFERENCE = /^(?:is|are|was|were)\s+(?:surrounded|seen|addressed|offered|invited|greeted|blocked|covered|illuminated|visible|near|beside|between|in|at|under|behind|before|a\b|an\b|the\b)/i;

/** Remove model-authored player lines, without changing player input, choices or gameplay deltas.
 * This deterministic filter recognizes explicit player markers and common narrated actions;
 * it does not infer that an ambiguous he/she/they refers to the player. */
export function purgePlayerAgency(parsed: ParseResult, raw = "", aliases: readonly (string | null | undefined)[] = [], cast: readonly string[] = [], personaControlMode?: unknown): { parsed: ParseResult; raw: string; removed: boolean } {
  if (normalizePersonaControlMode(personaControlMode) === 'ai') return { parsed, raw, removed: false };
  const alias = (text: string) => String(anonymizePlayerPrompt([{ content: text }], aliases, cast)[0]!.content);
  const player = (name?: string) => !!name && PLAYER.test(alias(name.trim()));
  const outsideQuotes = (text: string) => text.replace(/"[^"\n]*"|“[^”]*”|「[^」]*」|『[^』]*』/g, "");
  let removed = false;

  function segments(value: unknown): unknown {
    let list = value;
    const encoded = typeof list === "string";
    if (encoded) { try { list = JSON.parse(list as string); } catch { return value; } }
    if (!Array.isArray(list)) return value;
    const cleaned = list.flatMap(segment => {
      if (!segment || typeof segment !== "object") return [segment];
      if (typeof segment.speaker === "string" && player(segment.speaker)) { removed = true; return []; }
      if (typeof segment.text !== "string") return [segment];
      const text = narrative(segment.text, segment.speaker);
      if (text === segment.text) return [segment];
      if (!text.trim()) return [];
      return [{ ...segment, text }];
    });
    return encoded ? JSON.stringify(cleaned) : cleaned;
  }

  // Keep hidden state/audio commands even when they share a removed prose line.
  function protectCommands(text: string, controls: string[], restoreLiterals: (value: string) => string): string {
    // Use the guard's visibility rules before removing player prose, so hidden
    // reasoning cannot become an active receipt when its opening tag is removed.
    const visible = ThinkingTagFilter.strip(text);
    if (visible !== text.replace(/\n{3,}/g, "\n\n").trim()) text = visible;
    const receiptLine = /^[\t ]*<yumina-state\b[^\n]*/gm;
    const receipts = [...text.matchAll(receiptLine)];
    text = text.replace(receiptLine, (source, offset: number) => {
      const tail = text.slice(offset + source.length);
      // Keep malformed/duplicate metadata for strict validation. A lone
      // nonterminal marker may survive only the engine's existing updated +
      // command-only-tail case; removing prose must never validate bad placement.
      if (receipts.length === 1 && tail.trim() && (!/^<yumina-state\s+version="1"\s+status="updated"\s+count="[1-9]\d*"\s*\/>$/.test(restoreLiterals(source).trim())
        || new ResponseParser().parse(restoreLiterals(tail)).cleanText.trim())) return '';
      return `\u0001${controls.push(source) - 1}\u0001`;
    });
    let output = "", cursor = 0;
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "[") continue;
      let depth = 0, quoted = false, end = start;
      for (; end < text.length; end++) {
        const char = text[end];
        if (quoted) { if (char === "\\") end++; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === "[") depth++;
        else if (char === "]" && --depth === 0) { end++; break; }
      }
      if (depth !== 0 || quoted) continue;
      const source = text.slice(start, end);
      if (/^\[\s*(?:speaker|name|scene)\s*:/i.test(source)) continue;
      const command = new ResponseParser().parse(source);
      if (command.cleanText || !command.effects.length && !command.audioEffects.length) continue;
      const effects = command.effects.map(effect => effect.variableId === "segments" ? { ...effect, value: segments(effect.value) as typeof effect.value } : effect);
      const saved = effects.some((effect, i) => JSON.stringify(effect.value) !== JSON.stringify(command.effects[i]?.value))
        ? effects.map(effect => `[${effect.variableId}: ${effect.operation} ${JSON.stringify(effect.value)}]`).join("\n") : source;
      output += text.slice(cursor, start) + `\u0001${controls.push(saved) - 1}\u0001`;
      cursor = end; start = end - 1;
    }
    return (output + text.slice(cursor)).replace(/<state-updates\b[^>]*\/?>(?:[\s\S]*?<\/state-updates>)?/gi, source => `\u0001${controls.push(source) - 1}\u0001`);
  }

  function narrative(text: string, initialSpeaker?: string): string {
    const choices = extractResponseChoices(text);
    const literals = maskPresentationLiterals(choices.text);
    const controls: string[] = [];
    const source = protectCommands(literals.text, controls, literals.restore);
    let playerBlock = player(initialSpeaker);
    let dialogueBlock = !!initialSpeaker && !playerBlock && !/^(?:narrator|narration)$/i.test(initialSpeaker);
    const lines = source.replace(/(?=\[(?:speaker|name)\s*:)/gi, "\n").split("\n");
    const kept: string[] = [];
    let changed = false, pendingPlayerSpeech = false;
    for (const line of lines) {
      const analyzed = alias(line);
      const marker = /^\s*\[(?:speaker|name)\s*:\s*([^:\]\n]+)(?::[^\]\n]*)?\]/i.exec(analyzed)
        ?? /^\s*(?:\*{0,2})?(\{\{user\}\}|you|user|player|narrator|[\p{L}][\p{L} .'-]{0,60})\s*:/iu.exec(analyzed);
      if (marker) {
        playerBlock = player(marker[1]);
        // Some models label the player's invented speech as an unspecified
        // NPC immediately after explicitly narrating the player speaking.
        const unspecifiedNpc = /^npc$/i.test(marker[1]!.trim()) && !/:(?:male|female):/i.test(marker[0]);
        if (pendingPlayerSpeech && unspecifiedNpc) playerBlock = true;
        else if (!/^(?:narrator|narration)$/i.test(marker[1]!.trim())) pendingPlayerSpeech = false;
        dialogueBlock = !playerBlock && !/^(?:narrator|narration)$/i.test(marker[1]!.trim());
      }
      // A numbered suggestion is not an enacted action.
      const suggestion = /^\s*\d+[.)]\s+/.test(analyzed);
      const body = marker ? analyzed.slice(marker[0].length) : analyzed;
      const actionText = dialogueBlock && (marker || initialSpeaker && line === lines.find(value => value.trim()))
        ? (body.match(/\*[^*]+\*/g) ?? []).join(" ") : outsideQuotes(body);
      const controlsPlayer = [...actionText.matchAll(PLAYER_SUBJECT)].some(match => !PASSIVE_REFERENCE.test(match[1]!));
      if (!suggestion && (playerBlock || ACTION.test(actionText) || controlsPlayer)) {
        if (/(?:\{\{user\}\}|\byou\b)(?:(?![.!?;]|\b(?:as|while)\b)[^\n])*\b(?:speaks?|spoke|speaking|says?|said|saying|asks?|asked|repl(?:y|ies|ied)|answers?|answered|whispers?|whispered|shouts?|shouted)\b/i.test(actionText)) pendingPlayerSpeech = true;
        changed = true; removed = true;
        // Controls remain in order; prose sharing this line is discarded.
        const hidden = line.match(/\u0001\d+\u0001/g);
        if (hidden) kept.push(hidden.join(" "));
      } else {
        if (body.trim() && !playerBlock) pendingPlayerSpeech = false;
        kept.push(line);
      }
    }
    const restore = (value: string) => literals.restore(value.replace(/\u0001(\d+)\u0001/g, (_, index) => controls[Number(index)]!));
    const result = changed ? restore(kept.join("\n")).replace(/\n{3,}/g, "\n\n").trim() : restore(source);
    // Preserve the original bytes when no narrative/command changed.
    if (!changed && result === choices.text) return text;
    return result + (choices.choices !== undefined ? `\n[CHOICES:${JSON.stringify(choices.choices)}]` : "");
  }

  // Sanitize structured presentation without touching authoritative state writes.
  function envelope(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    if (typeof result.narrative === "string") result.narrative = narrative(result.narrative);
    if (result.segments !== undefined) result.segments = segments(result.segments);
    if (Array.isArray(result.stateChanges)) result.stateChanges = result.stateChanges.map(effect => effect?.variableId === "segments" ? { ...effect, value: segments(effect.value) } : effect);
    else if (result.stateChanges && typeof result.stateChanges === "object" && "segments" in result.stateChanges) result.stateChanges = { ...result.stateChanges, segments: segments(result.stateChanges.segments) };
    return result;
  }

  let cleanRaw = raw;
  const unfenced = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i, "$1");
  if (unfenced.startsWith("{")) {
    try {
      const original = JSON.parse(unfenced);
      if (original && typeof original === "object" && !Array.isArray(original)) {
        const cleaned = envelope(original);
        if (JSON.stringify(cleaned) !== JSON.stringify(original)) cleanRaw = JSON.stringify(cleaned);
      }
    } catch {
      // Keep truncated envelopes parseable by the existing recovery path. Decode
      // complete narrative strings before checking them, rather than treating
      // their JSON quotes as NPC speech.
      const fields = /"(narrative|stateChanges|segments)"\s*:\s*/g;
      let output = "", cursor = 0, match: RegExpExecArray | null;
      while ((match = fields.exec(raw))) {
        const start = fields.lastIndex;
        if (!/["\[{]/.test(raw[start] ?? "")) continue;
        let depth = 0, quoted = false, end = start;
        for (; end < raw.length; end++) {
          const char = raw[end];
          if (quoted) {
            if (char === "\\") end++;
            else if (char === '"') { quoted = false; if (depth === 0) { end++; break; } }
          } else if (char === '"') quoted = true;
          else if (char === "[" || char === "{") depth++;
          else if ((char === "]" || char === "}") && --depth === 0) { end++; break; }
        }
        if (quoted || depth !== 0) continue;
        try {
          const value = JSON.parse(raw.slice(start, end));
          const key = match[1]!;
          const cleaned = envelope({ [key]: value })[key];
          output += raw.slice(cursor, start) + JSON.stringify(cleaned);
          cursor = end; fields.lastIndex = end;
        } catch { /* Keep malformed state data for the existing validator. */ }
      }
      cleanRaw = output + raw.slice(cursor);
    }
  } else cleanRaw = narrative(raw);

  const wasPlayerSpeaker = player(parsed.speaker);
  let cleanText = narrative(parsed.cleanText === raw ? cleanRaw : parsed.cleanText, parsed.speaker);
  const effects = parsed.effects.map(effect => effect.variableId === "segments" ? { ...effect, value: segments(effect.value) as typeof effect.value } : effect);
  let speaker = wasPlayerSpeaker ? undefined : parsed.speaker;
  if (removed && !cleanText.replace(/^\s*\[(?:speaker|name|scene)\s*:[^\]\n]*\]\s*/gim, "").trim()) {
    cleanText = PAUSE; speaker = "narrator";
    if (cleanRaw.trim().startsWith("{")) {
      try { cleanRaw = JSON.stringify({ ...JSON.parse(cleanRaw), narrative: PAUSE }); }
      catch { cleanRaw += `\n[SPEAKER:Narrator:normal]\n${PAUSE}`; }
    } else cleanRaw = `[SPEAKER:Narrator:normal]\n${PAUSE}\n${cleanRaw}`.trim();
  }
  return { parsed: removed ? { ...parsed, cleanText, effects, speaker } : parsed, raw: cleanRaw, removed };
}
