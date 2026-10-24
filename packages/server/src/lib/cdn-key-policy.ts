const PUBLIC_PREFIXES = ["worlds/", "reports/", "studio-chat/", "users/", "bundles/", "dm/", "community/"];
/** Both CDN entry points apply this, including ID lookups. */
export function isPublicCdnKey(key: string): boolean {
    return !key.includes("..") && !key.includes("\\") && PUBLIC_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Resolve the current logical binding before its public key can be streamed. */
export async function resolvePublicCdnKey(
    lookup: () => Promise<string | null>,
): Promise<string | null> {
    const key = await lookup();
    if (!key || !isPublicCdnKey(key)) return null;
    return key;
}
