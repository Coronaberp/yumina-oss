import type { SSEStreamingApi } from "hono/streaming";

/** Report activity without exposing story text before turn validation. */
export function createGenerationProgressReporter(
  write: (message: Parameters<SSEStreamingApi["writeSSE"]>[0]) => Promise<void>,
) {
  let chars = 0;
  let lastTokens = 0;
  let lastSentAt = 0;
  return async (chunk: { type: string; content: string }) => {
    if (chunk.type === "text" || chunk.type === "reasoning") chars += chunk.content.length;
    else if (chunk.type !== "done") return;
    // Providers generally report usage only at completion. The live counter
    // is an estimate of generated text + thinking, never prompt tokens.
    const tokens = Math.ceil(chars / 4);
    const now = Date.now();
    if (tokens === lastTokens || (lastTokens > 0 && chunk.type !== "done" && now - lastSentAt < 100)) return;
    lastTokens = tokens;
    lastSentAt = now;
    await write({ event: "progress", data: JSON.stringify({ tokens }) });
  };
}
