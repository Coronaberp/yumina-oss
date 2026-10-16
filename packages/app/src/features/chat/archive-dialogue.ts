import type { SessionArchive } from "@yumina/shared";
import { canonicalCharacterName, displayCharacterName, extractResponseChoices, isPresentationLiteral, presentationLiteralRanges, standardizeSpeakerMarkup, stripGameStateDump, stripStateReceipts } from "@yumina/engine";
import { splitSpeakerSections } from "../../../sandbox/chat/speaker";
import { dialogueSpans, plainDialogue } from "../../../sandbox/chat/dialogue-spans";

/** Use the same attribution helpers as the chat, retaining narrator passages
 * and explicit player speech without manufacturing identities. */
export function populateArchiveDialogue(archive: SessionArchive): SessionArchive {
  const participants = new Map(archive.participants.map(p => [p.id, p]));
  const names = archive.participants.filter(p => p.id.startsWith("character:")).map(p => p.name);
  const entries = names.map(name => ({ name, role: "character", enabled: true, portrait: participants.get(`character:${name}`)?.avatar }));
  const display: SessionArchive["display"] = [];
  let turn = 0;
  for (const message of archive.messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") turn++;
    if (message.role === "user") { display.push({ messageId: message.id, speakerId: "player", kind: "choice", text: message.content.replace(/\{\{user\}\}/gi, archive.player.name), turn: Math.max(1, turn + 1) }); continue; }
    const text = stripStateReceipts(stripGameStateDump(extractResponseChoices(standardizeSpeakerMarkup(message.content.replace(/[\u200b\u2060]/g, ""), names)).text));
    const raw = message.swipes?.[message.activeSwipeIndex ?? 0]?.rawContent;
    const initial = /^\s*\[\s*(?:speaker|name)\s*:\s*([^:\]\n]+)/i.exec(typeof raw === "string" ? raw : text)?.[1]?.trim() || (typeof message.presentationSpeaker === "string" ? message.presentationSpeaker : "");
    const ranges = presentationLiteralRanges(text);
    let offset = 0, speaker = initial;
    const chunks: Array<{ text: string; speaker: string }> = [];
    const marker = /\[\s*(?:SPEAKER|Name)\s*:\s*([^:\]\n]+)(?:\s*:[^\]\n]+)?\]/gi;
    for (const match of text.matchAll(marker)) {
      if (isPresentationLiteral(ranges, match.index)) continue;
      chunks.push({ text: text.slice(offset, match.index), speaker });
      speaker = match[1].trim(); offset = match.index + match[0].length;
    }
    chunks.push({ text: text.slice(offset), speaker });
    for (const chunk of chunks) {
      const player = /^(?:\{\{user\}\}|you|user|player)$/i.test(chunk.speaker) || chunk.speaker === archive.player.name;
      const known = canonicalCharacterName(names, displayCharacterName(chunk.speaker));
      const tag = chunk.speaker ? `[speaker: ${player ? archive.player.name : known || (chunk.speaker.toLowerCase() === "narrator" ? "narrator" : "NPC")}]\n` : "";
      const speakers = player ? [...entries, { name: archive.player.name, role: "character", enabled: true, portrait: archive.player.avatar }] : entries;
      for (const section of splitSpeakerSections(speakers, chunk.text, tag + chunk.text)) {
        const spans = dialogueSpans(section.content);
        const quoted = spans.some(span => span.kind === "dialogue");
        for (const span of spans) {
          let copy = span.text.trim(); if (!copy) continue;
          const spoken = span.kind === "dialogue" || span.kind === "text" && !quoted && !!section.speaker;
          const name = spoken ? section.speaker?.name || (player ? archive.player.name : known || "NPC") : "Narrator";
          const key = name === archive.player.name && player ? "player" : spoken ? `character:${name}` : "narrator";
          if (!participants.has(key)) participants.set(key, { id: key, name, avatar: null });
          if (span.kind === "dialogue") copy = plainDialogue(copy).replace(/^["'“‘«「『]([\s\S]*?)["'”’»」』]$/, "$1");
          if (span.kind === "action") copy = copy.replace(/^(\*{1,3}|_{1,3})([\s\S]*?)\1$/, "$2");
          display.push({ messageId: message.id, speakerId: key, kind: spoken ? "dialogue" : "narration", text: copy.replace(/\{\{user\}\}/gi, archive.player.name), turn });
        }
      }
    }
    if (!display.some(row => row.messageId === message.id)) display.push({ messageId: message.id, speakerId: "narrator", kind: "narration", text: message.content, turn });
  }
  return { ...archive, participants: [...participants.values()], display };
}
