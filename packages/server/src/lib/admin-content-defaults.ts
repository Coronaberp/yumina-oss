import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user } from '../db/schema.js';
import { env, IS_LOCAL_EDITION } from './env.js';
import { resolveSavedProfileProvider, type ResolvedSavedProfile } from './saved-profile-provider.js';
import type { LLMProvider } from './llm/types.js';
import { isJsonModeUnsupported, providerFailureCode } from './llm/provider-errors.js';

export type ContentEndpointDefaults = Partial<Record<'sfw' | 'nsfw', { provider: string; model: string }>>;

/** Upstream diagnostics can echo authorization headers or private endpoint URLs. */
function publicAdminProvider(provider: LLMProvider, kind: 'sfw' | 'nsfw', model: string): LLMProvider {
  const message = `The admin ${kind.toUpperCase()} provider request failed. Ask the administrator to check its configuration.`;
  const safeMessage = (error: unknown) => {
    const diagnostic = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    // Preserve recovery categories using fixed text, never upstream diagnostic
    // bytes. State corrections need JSON-mode rejections to negotiate once.
    if (isJsonModeUnsupported(new Error(diagnostic))) return `response_format is unsupported. ${message}`;
    const category = providerFailureCode(diagnostic);
    const prefix: Record<string, string> = {
      provider_auth: 'Provider authentication failed (401). ',
      provider_rate_limit: 'Provider rate limit exceeded (429). ',
      provider_context_limit: 'Provider context length exceeded. ',
      provider_model_unavailable: 'Model unavailable. ',
      provider_unsupported_format: 'Provider parameter or format is unsupported. ',
    };
    if (prefix[category]) return prefix[category] + message;
    const transient = /\b5\d{2}\b|timeout|timed out|econnreset|econnrefused|network/i.test(diagnostic);
    return (transient ? 'Temporary network failure. ' : '') + message;
  };
  const safe = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) { throw new Error(safeMessage(error)); }
  };
  return {
    async *generateStream(params) {
      try {
        for await (const chunk of provider.generateStream({ ...params, model, lockModel: true,
          fallbackModels: undefined, fallbackOnTransientErrors: false })) {
          if (chunk.type === 'error') yield { type: 'error', content: safeMessage(chunk.content),
            ...(['unavailable', 'policy', 'capacity'].includes(chunk.fallbackReason ?? '') ? { fallbackReason: chunk.fallbackReason } : {}) };
          else yield chunk;
        }
      } catch (error) {
        if (params.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        yield { type: 'error', content: safeMessage(error) };
      }
    },
    listModels: () => safe(() => provider.listModels()),
    ...(provider.getContextWindow ? { getContextWindow: () => safe(() => provider.getContextWindow!()) } : {}),
    ...(provider.verify ? { verify: () => safe(() => provider.verify!()) } : {}),
  };
}

/** Only the installation's pinned administrator can supply shared credentials. */
async function readAdminProfiles() {
  if (!IS_LOCAL_EDITION || !env.YUMINA_ADMIN_ACCOUNT_ID) return null;
  const [admin] = await db.select({ id: user.id, preferences: user.preferences }).from(user)
    .where(and(eq(user.id, env.YUMINA_ADMIN_ACCOUNT_ID), eq(user.role, 'admin')));
  if (!admin) return null;
  // Share only the administrator's explicit assignments. Do not infer an
  // active default from the first saved profile: that could expose an
  // inactive administrator profile to every other account.
  const explicit = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
  return { ownerId: admin.id, sfw: explicit(admin.preferences?.activeApiKeyId),
    nsfw: explicit(admin.preferences?.nsfwApiKeyId) };
}

/** Undefined means no shared default. Null means its selected profile is invalid. */
export async function resolveAdminContentProvider(kind: 'sfw' | 'nsfw'): Promise<ResolvedSavedProfile | null | undefined> {
  const admin = await readAdminProfiles();
  if (!admin?.[kind]) return undefined;
  const resolved = await resolveSavedProfileProvider(admin.ownerId, admin[kind]);
  return resolved && { ...resolved, provider: publicAdminProvider(resolved.provider, kind, resolved.model) };
}

/** Public model metadata only; never return admin profile IDs, URLs or key metadata. */
export async function readPublicAdminContentDefaults(): Promise<{ ownerId: string; defaults: ContentEndpointDefaults; inheritSfwDefault: boolean } | null> {
  const admin = await readAdminProfiles();
  if (!admin) return null;
  const defaults: ContentEndpointDefaults = {};
  for (const kind of ['sfw', 'nsfw'] as const) {
    const resolved = await resolveSavedProfileProvider(admin.ownerId, admin[kind]);
    if (resolved) defaults[kind] = { provider: resolved.providerName, model: resolved.model };
  }
  return { ownerId: admin.ownerId, defaults, inheritSfwDefault: !!admin.sfw };
}
