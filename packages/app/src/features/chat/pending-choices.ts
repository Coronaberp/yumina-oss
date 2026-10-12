import { extractResponseChoices, normalizeChoices } from "@yumina/engine";

/** Only the selected swipe of the final reply may offer player options. */
export function pendingChoicesFromMessages(messages: ReadonlyArray<{ role: string; content?: string; activeSwipeIndex?: number; swipes?: ReadonlyArray<{ choices?: string[]; content?: string; rawContent?: string }> }>): string[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  const swipe = last.swipes?.[last.activeSwipeIndex ?? 0];
  const choices = normalizeChoices(swipe?.choices);
  if (choices?.length) return choices;
  for (const text of [swipe?.rawContent, swipe?.content, last.content]) {
    const parsed = extractResponseChoices(text || "").choices;
    if (parsed !== undefined) return parsed;
  }
  return [];
}
