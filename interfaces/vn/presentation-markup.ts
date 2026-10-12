import { normalizeSpriteExpression as expression } from "./expressions";
import { canonicalCharacterName } from "./speaker-tag";
import { isPresentationLiteral, presentationLiteralRanges } from "./presentation-literals";

/** Standardize explicit presentation structure, never infer story actions or state. */
export function standardizeSpeakerMarkup(text: string, names: readonly string[] = [], extended = true): string {
  let literals = presentationLiteralRanges(text);
  text = text.replace(/<(speaker|dialogue)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (source, tag: string, attrs: string, body: string, index: number) => {
    if (isPresentationLiteral(literals, index)) return source;
    const name = /(?:^|\s)(?:name|speaker)\s*=\s*["']([^"'\r\n]+)["']/i.exec(attrs)?.[1]?.trim();
    if (!name || /[:\]\r\n]/.test(name)) return source;
    const emotion = /(?:^|\s)(?:emotion|expression)\s*=\s*["']([^"'\r\n]+)["']/i.exec(attrs)?.[1];
    const content = body.trim();
    const speech = tag.toLowerCase() === "dialogue" && !/^["'“‘«「『]/.test(content) ? `“${content}”` : content;
    return `[SPEAKER:${name}:${expression(emotion)}]\n${speech}`;
  });
  literals = presentationLiteralRanges(text);
  text = text.replace(/<(narration|action)\s*>([\s\S]*?)<\/\1\s*>/gi, (source, _tag: string, body: string, index: number) => {
    if (isPresentationLiteral(literals, index)) return source;
    const content = body.trim();
    return `[SPEAKER:Narrator:normal]\n${/^\*.*\*$/s.test(content) ? content : `*${content}*`}`;
  });
  literals = presentationLiteralRanges(text);
  return text.replace(/\[\s*(SPEAKER|Name)\s*:\s*([^:\]\n|]+)\s*(?:[:|]\s*([^\]\n]+))?\]/gi, (source, _key: string, rawName: string, rawFields: string | undefined, index: number) => {
    if (isPresentationLiteral(literals, index) || (!extended && !rawFields)) return source;
    const inputName = rawName.trim();
    const name = /^(narrator|narration)$/i.test(inputName) ? "Narrator" : /^npc$/i.test(inputName) ? "NPC" : canonicalCharacterName(names, inputName) || inputName;
    const fields = (rawFields || "normal").split(/[:|]/).map(field => field.trim());
    const emotion = name === "Narrator" ? "normal" : expression(fields[0]);
    const gender = name === "NPC" && /^(male|female)$/i.test(fields[1] || "") ? fields[1]!.toLowerCase() : "";
    const id = gender ? fields.slice(2).join(":").trim() : "";
    return `[SPEAKER:${name}:${emotion}${gender ? `:${gender}${id ? `:${id}` : ""}` : ""}]`;
  });
}
