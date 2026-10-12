import type { ChatMessage } from "../llm/types.js";

function messageText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map(part => "text" in part ? part.text : "").join("\n");
}

/** Explicit naming requests are gated in the harness, independently of prompting. */
export function studioNamingRequest(messages: readonly ChatMessage[]) {
  let latestUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") { latestUser = i; break; }
  if (latestUser < 0) return { required: false, namesOnly: false };
  const text = messageText(messages[latestUser]!).trim().toLowerCase();
  const namingText = text.replace(/\b(?:name|names|naming)\s+(?:generator|generation|profiles?|tool)\b/g, "")
    .replace(/\b(?:your|file|variable|function|tool)\s+names?\b/g, "");
  const naming = /\b(?:names?|surnames?|nicknames?)\b/.test(namingText);
  const request = /\b(?:generate|suggest|brainstorm|give|make|create|need|want|provide|invent|find|pick|choose|recommend|list|rename)\b/.test(text)
    || /^(?:names?|surnames?|nicknames?)(?:\s+(?:please|pls|for|like|in)\b|\s*[!.?]*$)/.test(text)
    || /^name\s+(?:my|this|the|an?|these)\b/.test(text);
  const required = (naming && request)
    || /(?:生成|起|取|给|推薦|推荐).{0,20}(?:名字|姓名|名称)/u.test(text);
  const namesOnly = required && !/\b(?:add|create|write|build|design|update|edit)\b.{0,30}\b(?:characters?|npcs?|entries|story|world|lore|card|profiles?)\b/.test(text)
    && !/\b(?:descriptions?|backstories|biograph(?:y|ies)|personalit(?:y|ies)|traits|stats|dialogue)\b/.test(text);
  const ids = new Set(messages.slice(latestUser + 1).flatMap(message => message.role === "assistant"
    ? (message.tool_calls ?? []).filter(call => call.function.name === "generate_names").map(call => call.id) : []));
  const satisfied = messages.slice(latestUser + 1).some(message => {
    if (message.role !== "tool" || !ids.has(message.tool_call_id)) return false;
    try { const result = JSON.parse(messageText(message)); return result.source === "phonetic-generator" && result.names?.length > 0; } catch { return false; }
  });
  return { required: required && !satisfied, namesOnly };
}
