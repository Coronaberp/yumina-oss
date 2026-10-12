/** Prompt post-processing modes (mirror SillyTavern's set).
 *  Controls how messages are normalized before being sent to a custom OpenAI-compatible endpoint
 *  whose backing model may not tolerate arbitrary role sequences. */
export type PromptPostProcessing =
  | "none"          // pass through as-is
  | "merge"         // merge consecutive same-role messages
  | "merge_tools"   // merge + keep tool messages intact
  | "semi"          // enforce alternation, allow leading system
  | "semi_tools"    // semi + keep tool messages intact
  | "strict"        // hard alternation user/assistant only (Claude-style)
  | "strict_tools"  // strict + keep tool messages intact
  | "single";       // collapse all into one user message

/** Exact OpenRouter endpoint slugs, saved independently for each model. */
export type OpenRouterProviderSelections = Record<string, string[]>;

export interface OpenRouterProviderEndpoint {
  slug: string;
  name: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
}

/** Starting point for creative stories with focused word choices. */
export const PROFILE_SAMPLING_DEFAULTS = { temperature: 0.8, topP: 0.95, topK: 40 } as const;

/** Metadata for a user API key. Most fields only meaningful for provider='custom'. */
export interface ApiKeyMetadata {
  /** Per-profile creativity controls. Null/absent uses PROFILE_SAMPLING_DEFAULTS. */
  temperature?: number | null;
  topP?: number | null;
  /** Zero omits top-k filtering and uses the provider's default. */
  topK?: number | null;
  /** OpenRouter only. Missing model entries use the account's routing defaults. */
  openRouterProviders?: OpenRouterProviderSelections;
  /** Saved effort for this endpoint. Absent profiles use the request effort, then low. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Total endpoint window (input plus output). Null/absent uses automatic detection. */
  contextWindow?: number | null;
  /** Whitelist of upstream model names. Stored WITHOUT the "custom/" prefix. */
  models?: string[];
  /** Last successful upstream catalog, used to distinguish discovered and manual IDs. */
  discoveredModels?: string[];
  /** Server timestamp (milliseconds) of the last successful catalog sync. */
  modelsSyncedAt?: number;
  /** Extra body fields merged into every chat-completion request (e.g. {"top_k": 40}). */
  includeBody?: Record<string, unknown>;
  /** Body field names to strip from every request (e.g. ["frequency_penalty"]). */
  excludeBody?: string[];
  /** Extra headers merged into every request. Authorization is always controlled by the stored key. */
  includeHeaders?: Record<string, string>;
  /** Role-alternation strategy applied to messages before send. */
  promptPostProcessing?: PromptPostProcessing;
  /** Last-used model from this profile (UX hint, not authoritative). */
  defaultModel?: string;
}
