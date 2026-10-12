import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, playSessions, worlds } from "../db/schema.js";
import { IS_LOCAL_EDITION } from "./env.js";
import { resolveProviderForModel, type ResolvedProvider } from "./resolve-provider.js";
import { resolveSavedProfileProvider } from "./saved-profile-provider.js";
import { resolveAdminContentProvider } from './admin-content-defaults.js';

export type ResolvedStoryProvider = ResolvedProvider & { model: string; profileId?: string };

export async function isProtectedStorySession(userId: string, sessionId: string): Promise<boolean> {
  const [world] = await db.select({ allowCustomApi: worlds.allowCustomApi, creatorId: worlds.creatorId }).from(playSessions)
    .innerJoin(worlds, eq(worlds.id, playSessions.worldId)).where(eq(playSessions.id, sessionId));
  return world?.allowCustomApi === false && world.creatorId !== userId;
}

/** A selected saved Story profile owns provider routing. Model vendor prefixes
 * never change an OpenRouter connection into a direct vendor connection. */
export async function resolveStoryProviderForModel(userId: string, model: string, options?: Parameters<typeof resolveProviderForModel>[2] & { fallbackApiKeyId?: unknown }): Promise<ResolvedStoryProvider | null> {
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  if (!account) return null;
  if (options?.fallbackApiKeyId !== undefined) {
    if (options.forceOfficial) return null;
    return resolveSavedProfileProvider(userId, options.fallbackApiKeyId);
  }
  const prefs = account?.preferences;
  const privateMode = options?.forcePrivate || IS_LOCAL_EDITION || prefs?.preferredProvider === "private";
  if (!options?.forceOfficial && privateMode && !model.startsWith("local/") && typeof prefs?.activeApiKeyId === "string" && prefs.activeApiKeyId) {
    return resolveSavedProfileProvider(userId, prefs.activeApiKeyId, model);
  }
  if (!options?.forceOfficial && privateMode && !model.startsWith('local/')) {
    const inherited = await resolveAdminContentProvider('sfw');
    if (inherited !== undefined) return inherited;
  }
  const resolved = await resolveProviderForModel(userId, model, options);
  return resolved && { ...resolved, model };
}

/** Reveal only whether the effective failed connection was the user's own backup. */
export async function failedOnBackupProfile(userId: string, profileId: string | undefined): Promise<boolean> {
  if (!profileId) return false;
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  const config = account?.preferences?.aiConfig as Record<string, unknown> | undefined;
  const policy = config?.modelFallback as import('@yumina/shared').ModelFallbackPolicy | undefined;
  if (!policy?.privateKeyId || policy.privateKeyId !== profileId) return false;
  return !!await resolveSavedProfileProvider(userId, policy.privateKeyId);
}
