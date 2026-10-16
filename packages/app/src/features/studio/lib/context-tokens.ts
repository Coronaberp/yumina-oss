/** Client-side context-usage estimator for the Studio AI chat.
 *
 *  Shares the server's model budget so the UI meter reflects the actual
 *  threshold at which the server starts summarizing older messages.
 *
 *  Why client-side instead of trusting server-reported usage: we need to show
 *  the meter BEFORE the first send of each conversation, and progressively as
 *  the user types — before any provider response exists. After each server
 *  turn we could reconcile with `usage.promptTokens` if we ever want a true
 *  reading, but the estimate is close enough for a health indicator.
 */
import type { StudioChatMessage } from "./types";
export { getStudioContextBudget as getContextBudget } from "@yumina/shared";

// Mirrors agent.ts:456–467. CJK characters count ~1 token each (BPE tokenizers
// rarely merge them); ASCII stays ~4 chars/token. Undercounting CJK caused the
// original "Gemini 1M busts context" bug that motivated the aware estimator.
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

export function estimateMessageTokens(msg: StudioChatMessage): number {
  let total = estimateTextTokens(msg.content ?? "");
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) total += estimateTextTokens(tc.function.arguments ?? "");
  }
  // Attachments — images are multimodal placeholders; rough estimate matches server.
  if (msg.attachments?.length) total += msg.attachments.length * 200;
  return total;
}

/** Total tokens used by the conversation history (what the server will see as
 *  `messages` input, before system prompt + tools). */
export function estimateHistoryTokens(messages: StudioChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export type ContextHealth = "fresh" | "comfortable" | "filling" | "tight" | "compacting";

export interface ContextUsage {
  usedTokens: number;
  budgetTokens: number;
  percent: number;
  health: ContextHealth;
}

/** Classify usage into UX bands. Compaction kicks in server-side at 100% of
 *  budget (buildWindowedMessages only fires past budget) — we nudge earlier
 *  so the user can branch/start-fresh before losing nuance. */
export function classifyUsage(usedTokens: number, budgetTokens: number): ContextUsage {
  const percent = budgetTokens > 0 ? (usedTokens / budgetTokens) * 100 : 0;
  let health: ContextHealth;
  if (percent < 30) health = "fresh";
  else if (percent < 60) health = "comfortable";
  else if (percent < 80) health = "filling";
  else if (percent < 100) health = "tight";
  else health = "compacting";
  return { usedTokens, budgetTokens, percent, health };
}
