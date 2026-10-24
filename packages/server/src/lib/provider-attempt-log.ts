import { db } from "../db/index.js";
import { providerAttempts } from "../db/schema.js";
import type { GenerateParams, LLMProvider, ProviderAttempt } from "./llm/types.js";
import { normalizeProviderCostUsd } from "./provider-cost.js";

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

/** Await persistence before another paid retry. A lost acknowledgement can be
 * retried safely with the same primary key. Unknown usage stays NULL, not zero.
 * This never writes usage_logs, debits credits, or stores prompts/credentials. */
export async function recordProviderAttempt(userId: string, attempt: ProviderAttempt, profileId?: string): Promise<void> {
  const cost = normalizeProviderCostUsd(attempt.usage?.providerCostUsd);
  const values: typeof providerAttempts.$inferInsert = {
    id: attempt.id, invocationId: attempt.invocationId, userId, profileId,
    providerHost: attempt.providerHost, model: attempt.model, conversationId: attempt.conversationId,
    startedAt: new Date(attempt.startedAt), finishedAt: new Date(attempt.finishedAt),
    status: attempt.status, httpStatus: attempt.httpStatus,
    providerRequestId: attempt.providerRequestId?.slice(0, 200), stopReason: attempt.stopReason,
    promptTokens: tokenCount(attempt.usage?.promptTokens),
    completionTokens: tokenCount(attempt.usage?.completionTokens),
    totalTokens: tokenCount(attempt.usage?.totalTokens),
    reasoningTokens: tokenCount(attempt.usage?.reasoningTokens),
    providerCostUsd: cost === undefined ? null : cost.toFixed(12),
  };
  for (let retry = 0; ; retry++) {
    try {
      await db.insert(providerAttempts).values(values).onConflictDoNothing();
      return;
    } catch {
      if (retry === 0) continue;
      console.error(`[ProviderAttempt] Could not persist receipt ${attempt.id} after retry`);
      throw new Error("Could not save the provider request receipt; automatic retry stopped.");
    }
  }
}

/** Bind account/profile ownership at resolution, outside any model-supplied
 * parameters. Preserve all optional provider capabilities through the proxy. */
export function withProviderAttemptRecording(provider: LLMProvider, userId: string, profileId?: string): LLMProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "generateStream") return (params: GenerateParams) => target.generateStream({
        ...params,
        onProviderAttempt: async attempt => {
          await recordProviderAttempt(userId, attempt, profileId);
          await params.onProviderAttempt?.(attempt);
        },
      });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
