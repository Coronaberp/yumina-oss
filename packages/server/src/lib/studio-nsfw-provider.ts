import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, apiKeys } from "../db/schema.js";
import { resolveSavedProfileProvider, type ResolvedSavedProfile } from "./saved-profile-provider.js";
import { resolveAdminContentProvider } from "./admin-content-defaults.js";
import { env } from "./env.js";
import { CodexProvider, CODEX_STUDIO_MODEL, CODEX_STUDIO_EFFORT } from "./llm/codex.js";

export const STUDIO_NSFW_ENDPOINT_ERROR = "Choose an eligible agent profile, or configure an NSFW provider with a model and API key in Settings → AI config.";
export type StudioProfileSelection = { source: "default" } | { source: "nsfw" } | { source: "profile"; profileId: string };

function readSelection(preferences: Record<string, unknown> | null): StudioProfileSelection | null {
  const selection = preferences?.studioEndpoint as Partial<StudioProfileSelection> | undefined;
  if (selection === undefined || selection === null) return { source: "default" };
  if (selection.source === "default" || selection.source === "nsfw") return { source: selection.source };
  if (selection.source === "profile" && typeof selection.profileId === "string" && selection.profileId) return { source: "profile", profileId: selection.profileId };
  return null;
}

export function codexStudioSelection() {
  return env.YUMINA_EDITION === "local" && env.YUMINA_STUDIO_CODEX_ENABLED
    ? { source: "codex" as const, model: CODEX_STUDIO_MODEL, reasoningEffort: CODEX_STUDIO_EFFORT, label: "Codex account" } : null;
}

async function resolveNsfw(userId: string, preferences: Record<string, unknown> | null) {
  const selected = preferences?.nsfwApiKeyId;
  return typeof selected === "string" && selected ? resolveSavedProfileProvider(userId, selected)
    : (await resolveAdminContentProvider("nsfw")) ?? null;
}

/** Reference analysis uses the configured NSFW endpoint independently of the main Studio agent. */
export async function resolveStudioReferenceVisionProvider(userId: string): Promise<ResolvedSavedProfile | null> {
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  return account ? resolveNsfw(userId, account.preferences) : null;
}

/** Default is the shared host Codex login. An explicit profile is owned by the
 * caller and always uses its configured model. Story endpoint settings stay independent. */
export async function resolveStudioNsfwProvider(userId: string): Promise<ResolvedSavedProfile | null> {
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  if (!account) return null;
  const selection = readSelection(account.preferences);
  if (!selection) return null;
  if (selection.source === "profile") return resolveSavedProfileProvider(userId, selection.profileId);
  if (selection.source === "default" && codexStudioSelection()) return {
    provider: new CodexProvider(env.YUMINA_STUDIO_CODEX_BIN), providerName: "codex", model: CODEX_STUDIO_MODEL,
    profileId: "server-codex-studio", isByok: true, apiKeyTier: "byok",
  };
  return resolveNsfw(userId, account.preferences);
}

export async function readStudioProfileChoices(userId: string) {
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  if (!account) return null;
  const owned = await db.select().from(apiKeys).where(eq(apiKeys.userId, userId));
  const configured = await Promise.all(owned.map(async profile => ({
    profile, resolved: await resolveSavedProfileProvider(userId, profile.id),
  })));
  const nsfw = await resolveNsfw(userId, account.preferences);
  const codex = codexStudioSelection();
  const selection = readSelection(account.preferences);
  const profiles: Array<{ selection: StudioProfileSelection; label: string; model: string | null; reasoningEffort?: string }> = [
    { selection: { source: "default" }, label: codex ? "Codex account (default)" : "Default agent profile",
      model: codex?.model ?? nsfw?.model ?? null, ...(codex ? { reasoningEffort: CODEX_STUDIO_EFFORT } : {}) },
  ];
  if (nsfw) profiles.push({ selection: { source: "nsfw" }, label: "NSFW profile", model: nsfw.model });
  for (const { profile, resolved } of configured) {
    if (resolved) profiles.push({ selection: { source: "profile", profileId: profile.id }, label: profile.label || profile.provider,
      model: resolved.model, reasoningEffort: profile.metadata?.reasoningEffort ?? "low" });
  }
  const resolved = await resolveStudioNsfwProvider(userId);
  const option = profiles.find(p => JSON.stringify(p.selection) === JSON.stringify(selection));
  return {
    selection,
    current: resolved ? { source: resolved.providerName === "codex" ? "codex" : selection?.source === "profile" ? "profile" : "nsfw",
      model: resolved.model, label: option?.label ?? "Agent profile", ...(option?.reasoningEffort ? { reasoningEffort: option.reasoningEffort } : {}) } : null,
    profiles,
  };
}

export async function canSelectStudioProfile(userId: string, selection: StudioProfileSelection): Promise<boolean> {
  if (selection.source === "profile") return !!await resolveSavedProfileProvider(userId, selection.profileId);
  if (selection.source === "default" && codexStudioSelection()) return true;
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  return !!account && !!await resolveNsfw(userId, account.preferences);
}
