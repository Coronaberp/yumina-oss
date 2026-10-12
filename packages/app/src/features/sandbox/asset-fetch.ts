/** Download installation assets in the authenticated parent document. The
 * opaque sandbox cannot send the site's Cloudflare Access cookies itself. */
export async function fetchSandboxAsset(ref: unknown): Promise<Blob> {
  if (typeof ref !== "string") throw new Error("Invalid asset URL");
  const url = new URL(ref, window.location.origin);
  const apiOrigin = new URL(import.meta.env?.VITE_API_URL || window.location.origin, window.location.origin).origin;
  if (![window.location.origin, apiOrigin].includes(url.origin)
    || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password
    || !(url.pathname.startsWith("/cdn/") || url.pathname.startsWith("/vn-assets/"))) {
    throw new Error("Only installation asset URLs are allowed");
  }
  const response = await fetch(url.href, { credentials: "include", redirect: "error" });
  if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
  if (/^(?:text\/html|application\/json)\b/i.test(response.headers.get("content-type") || "")) {
    throw new Error("Asset download returned a page instead of media");
  }
  return response.blob();
}
