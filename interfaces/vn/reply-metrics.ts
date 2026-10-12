type ReplyUsage = {
  content?: string;
  rawContent?: string;
  reasoningContent?: string;
  tokenCount?: number | null;
  generationTimeMs?: number | null;
};

type Reply = ReplyUsage & {
  status?: string;
  activeSwipeIndex?: number;
  swipes?: ReplyUsage[];
};

const validCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function replyMetrics(message?: Reply) {
  if (!message || message.status === "failed" || message.status === "streaming") return null;
  const swipe = message.swipes?.[message.activeSwipeIndex || 0];
  const source = swipe || message;
  const totalTokens = validCount(source.tokenCount) ? source.tokenCount : null;
  // Older swipes do not save their own duration. The message duration can
  // belong to another version, so only use it for a single-version reply.
  const duration = source.generationTimeMs ?? ((message.swipes?.length || 0) > 1 ? null : message.generationTimeMs);
  const timed = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  if (totalTokens === null && !timed) return null;
  // Match the loading indicator's character estimate; include hidden output
  // directives and provider thinking rather than just the visible page.
  const outputTokens = Math.ceil(((source.rawContent ?? source.content ?? "").length + (source.reasoningContent || "").length) / 4);
  // Only the combined request count is persisted. Estimate input separately
  // instead of displaying that combined count as if it were input usage.
  const inputTokens = totalTokens !== null && totalTokens >= outputTokens ? totalTokens - outputTokens : null;
  return { totalTokens, inputTokens, outputTokens, estimatedTps: timed ? outputTokens / (duration / 1000) : null };
}
