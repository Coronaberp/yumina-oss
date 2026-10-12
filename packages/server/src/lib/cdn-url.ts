/**
 * Shared CDN URL resolution for images and assets.
 *
 * Converts raw S3 keys into deterministic `/cdn/key/...` URLs that
 * Cloudflare can cache. Replaces all the async `resolveImage()` /
 * `resolveThumbnail()` functions that generated presigned S3 URLs.
 */
import { env, PUBLIC_ORIGIN } from "./env.js";
import { getRequestMediaOrigin } from "./request-cache.js";

/** Use the caller's host; configured HTTPS handles TLS terminated by a proxy.
 * Never use forwarded headers to invent a different host or change auth config. */
export function cdnOriginForRequest(
  requestUrl: string,
  configuredOrigins: readonly string[] = [PUBLIC_ORIGIN, env.APP_URL, env.BETTER_AUTH_URL],
): string {
  const request = new URL(requestUrl);
  if (request.protocol === "https:") return request.origin;
  for (const value of configuredOrigins) {
    const configured = new URL(value);
    if (configured.host === request.host && configured.protocol === "https:") return configured.origin;
  }
  return request.origin;
}

/** Get the origin URL for absolute CDN paths */
function getOrigin(): string {
  return getRequestMediaOrigin() ?? PUBLIC_ORIGIN;
}

/**
 * Resolve an S3 key or existing URL for CDN serving.
 * - null/empty → null
 * - Starts with "http" → returned as-is (external URL or legacy presigned URL)
 * - Otherwise → treated as S3 key, encoded into absolute CDN URL
 *
 * Resolves storage keys to ABSOLUTE URLs (e.g., https://yumina.io/cdn/key/...) so they work
 * in custom components that parse URLs with `new URL(imageUrl)`.
 *
 * Synchronous — pure string manipulation, zero I/O.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_REF_RE = /^@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function resolveImageCdn(url: string | null | undefined): string | null {
  if (!url) return null;
  // Local upload responses can be saved directly as profile/persona images.
  // These are already resolved and must not be encoded as another storage key.
  if (url.startsWith("/cdn/")) return url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  // @asset:UUID references → extract the UUID and route to /cdn/:assetId
  const assetMatch = ASSET_REF_RE.exec(url);
  if (assetMatch) return `${getOrigin()}/cdn/${assetMatch[1]}`;
  // Bare asset IDs (UUIDs) → /cdn/:assetId (DB lookup for S3 key)
  if (UUID_RE.test(url)) return `${getOrigin()}/cdn/${url}`;
  // S3 keys (e.g. "worlds/abc.jpg") → /cdn/key/:encodedKey
  return `${getOrigin()}/cdn/key/${Buffer.from(url, "utf-8").toString("base64url")}`;
}
