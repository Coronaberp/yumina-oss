import type { GenerateParams, LLMProvider } from "./types.js";
import { AI_GENERATION_DEFAULTS, PROFILE_SAMPLING_DEFAULTS, type ApiKeyMetadata } from "@yumina/shared";
import { OpenRouterProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { GoogleProvider } from "./google.js";
import { CustomProvider } from "./custom.js";
import { LocalBridgeProvider } from "./local-bridge.js";
import { cleanProviderText } from "./clean-provider-text.js";
import { CodexProvider } from "./codex.js";

export type ProviderName = "openrouter" | "anthropic" | "openai" | "google" | "ollama" | "custom" | "local" | "codex";

/** Apply saved profile settings while preserving explicit utility opt-outs. */
function withProfileSettings(provider: LLMProvider, metadata?: ApiKeyMetadata | null): LLMProvider {
  const limit = metadata?.contextWindow;
  const hasLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 512 && limit <= 2_000_000;
  return new Proxy(provider, {
    get(target, property) {
      if (property === "generateStream") return (params: GenerateParams) => target.generateStream({
        ...params,
        temperature: metadata?.temperature ?? params.temperature,
        topP: metadata?.topP ?? params.topP,
        topK: metadata?.topK ?? params.topK,
        reasoningEffort: params.disableReasoning ? "none" : metadata?.reasoningEffort ?? params.reasoningEffort ?? AI_GENERATION_DEFAULTS.reasoningEffort,
      });
      if (property === "getContextWindow" && hasLimit) return async () => {
        const detected = await target.getContextWindow?.();
        return typeof detected === "number" && Number.isFinite(detected) && detected > 0 ? Math.min(limit, detected) : limit;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Create a provider instance. `baseUrl` is custom-only; profile effort and context apply to every provider.
 *  For `provider === "local"` the first argument is the player's user id, not a key —
 *  the model runs on their machine and there is nothing to authenticate against. */
export function createProvider(
  provider: ProviderName,
  apiKeyOrUrl: string,
  baseUrl?: string,
  metadata?: ApiKeyMetadata | null,
): LLMProvider {
  return cleanProviderText(withProfileSettings(createRawProvider(provider, apiKeyOrUrl, baseUrl, metadata), metadata));
}

function createRawProvider(
  provider: ProviderName,
  apiKeyOrUrl: string,
  baseUrl?: string,
  metadata?: ApiKeyMetadata | null,
): LLMProvider {
  switch (provider) {
    case "codex":
      return new CodexProvider(apiKeyOrUrl || "codex");
    case "anthropic":
      return new AnthropicProvider(apiKeyOrUrl);
    case "openai":
      return new OpenAIProvider(apiKeyOrUrl);
    case "google":
      return new GoogleProvider(apiKeyOrUrl);
    case "ollama":
      return new OllamaProvider(apiKeyOrUrl);
    case "local":
      return new LocalBridgeProvider(apiKeyOrUrl);
    case "custom":
      if (!baseUrl) {
        throw new Error("createProvider: custom provider requires baseUrl");
      }
      return new CustomProvider(apiKeyOrUrl, baseUrl, metadata ?? null);
    case "openrouter":
    default:
      return new OpenRouterProvider(apiKeyOrUrl);
  }
}

/** Create a provider backed by a user-owned key. OpenRouter BYOK accounts may
 * configure their own upstream/provider routing, which request-level routing
 * must not override unless the user explicitly selects upstream providers. */
export function createByokProvider(
  provider: ProviderName,
  apiKeyOrUrl: string,
  baseUrl?: string,
  metadata?: ApiKeyMetadata | null,
): LLMProvider {
  metadata = {
    ...metadata,
    temperature: metadata?.temperature ?? PROFILE_SAMPLING_DEFAULTS.temperature,
    topP: metadata?.topP ?? PROFILE_SAMPLING_DEFAULTS.topP,
    topK: metadata?.topK ?? PROFILE_SAMPLING_DEFAULTS.topK,
  };
  if (provider === "openrouter") {
    return cleanProviderText(withProfileSettings(new OpenRouterProvider(apiKeyOrUrl, {
      preserveAccountRouting: true,
      providerSelections: metadata?.openRouterProviders,
    }), metadata));
  }
  return createProvider(provider, apiKeyOrUrl, baseUrl, metadata);
}

/** Infer provider from model ID prefix. */
export function inferProvider(modelId: string): ProviderName {
  if (modelId.startsWith("local/")) return "local";
  if (modelId.startsWith("custom/")) return "custom";
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.startsWith("google/")) return "google";
  if (modelId.startsWith("ollama/")) return "ollama";
  return "openrouter";
}
