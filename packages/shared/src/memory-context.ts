import { z } from "zod";

/** Matches StoryHaven's working-memory briefing default, separately from history. */
export const DEFAULT_MEMORY_RECALL_TOKENS = 1_000;
export const MAX_MEMORY_RECALL_TOKENS = 100_000;
export const memoryRecallBudgetSchema = z.number().int().min(1).max(MAX_MEMORY_RECALL_TOKENS);

/** Only an explicit chat override takes precedence over the account default. */
export function resolveMemoryRecallBudget(session: unknown, account: unknown): number {
  for (const value of [session, account]) {
    const parsed = memoryRecallBudgetSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_MEMORY_RECALL_TOKENS;
}
