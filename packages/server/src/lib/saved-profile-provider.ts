import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { decryptApiKey } from "./crypto.js";
import { IS_LOCAL_EDITION } from "./env.js";
import { isStrataLocalEndpoint } from "./ssrf.js";
import { createByokProvider, type ProviderName } from "./llm/provider-factory.js";
import { withProviderAttemptRecording } from "./provider-attempt-log.js";
import type { ResolvedProvider } from "./resolve-provider.js";

export type ResolvedSavedProfile = ResolvedProvider & { model: string; profileId: string };

/** Resolve this exact owned saved connection and its configured model. Missing
 * or invalid profiles never substitute another connection or an official key. */
export async function resolveSavedProfileProvider(userId: string, profileId: unknown, requestedModel?: string): Promise<ResolvedSavedProfile | null> {
  if (typeof profileId !== "string" || !profileId) return null;
  const [profile] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, profileId), eq(apiKeys.userId, userId)));
  if (!profile || !["custom", "openrouter", "anthropic", "openai", "google", "ollama"].includes(profile.provider)) return null;
  const providerName = profile.provider as ProviderName;
  const requested = requestedModel?.trim();
  // OpenRouter IDs already contain their vendor prefix. Direct connections
  // accept their own prefix or an unprefixed upstream ID, never another API's.
  const matchesProvider = requested && (providerName === "openrouter"
    ? !/^(custom|local|ollama)\//.test(requested)
    : requested.startsWith(`${providerName}/`) || !requested.includes("/"));
  const modelName = matchesProvider ? requested : profile.metadata?.defaultModel?.trim();
  if (!modelName || (providerName === "custom" && !profile.baseUrl)) return null;
  try {
    const key = decryptApiKey(profile.encryptedKey, profile.keyIv, profile.keyTag);
    const allowsKeylessStrata = IS_LOCAL_EDITION && isStrataLocalEndpoint(profile.baseUrl ?? "");
    if (key === null || (!key.trim() && !allowsKeylessStrata) || ["null", "undefined"].includes(key.trim().toLowerCase())) return null;
    const prefix = `${providerName}/`;
    const model = providerName === "openrouter" || modelName.startsWith(prefix) ? modelName : prefix + modelName;
    const provider = createByokProvider(providerName, key, profile.baseUrl ?? undefined, profile.metadata);
    return {
      provider: providerName === "custom" ? withProviderAttemptRecording(provider, userId, profile.id) : provider,
      providerName, model, profileId: profile.id, isByok: true, apiKeyTier: "byok",
    };
  } catch {
    return null;
  }
}
