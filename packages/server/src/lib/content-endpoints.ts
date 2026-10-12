/** Generation profiles, separate from the local CPU content classifier. */
export interface ContentEndpointSelection {
  sfwApiKeyId: string | null;
  nsfwApiKeyId: string | null;
}

/** Profiles are supplied newest first, matching the legacy custom-key fallback. */
export function readContentEndpoints(
  preferences: Record<string, unknown> | null,
  profiles: Array<{ id: string; provider: string }>,
  inheritSfwDefault = false,
): ContentEndpointSelection {
  const owned = (id: unknown) => typeof id === "string" && profiles.some(row => row.id === id) ? id : null;
  const nsfwApiKeyId = owned(preferences?.nsfwApiKeyId);
  const sfwApiKeyId = inheritSfwDefault && !preferences?.activeApiKeyId ? null : owned(preferences?.activeApiKeyId)
    ?? profiles.find(row => row.id !== nsfwApiKeyId && row.provider === "custom")?.id
    ?? profiles.find(row => row.id !== nsfwApiKeyId)?.id ?? null;
  return { sfwApiKeyId, nsfwApiKeyId };
}
