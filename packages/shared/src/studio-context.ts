/** Known native Codex context, shared by the provider and Studio history meter. */
export const CODEX_STUDIO_CONTEXT_WINDOW = 1_050_000;

/** History gets about 60% of context; the server also applies endpoint-specific
 * reserves for instructions, tool schemas and output before sending a request. */
export function getStudioContextBudget(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id === "codex/gpt-6-luna" || id === "gpt-6-luna") return Math.floor(CODEX_STUDIO_CONTEXT_WINDOW * 0.6);
  if (id.includes("gemini")) return 600_000;
  if (id.includes("claude")) {
    if (id.includes("sonnet-4.6") || id.includes("sonnet-4-6") || id.includes("-1m")) return 600_000;
    return 120_000;
  }
  if (id.includes("gpt-4o") || id.includes("gpt-4.1")) return 75_000;
  if (id.includes("grok") || id.includes("qwen") || id.includes("kimi")) return 75_000;
  if (id.includes("llama") || id.includes("mistral") || id.includes("deepseek")) return 50_000;
  return 120_000;
}
