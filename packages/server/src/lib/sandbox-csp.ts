/** Policy for the opaque-origin iframe that runs world interfaces. */
export function buildSandboxCsp(requestUrl: string, isLocalEdition: boolean, publicOrigin?: string): string {
  const localOrigins = new Set<string>();
  if (isLocalEdition) {
    for (const candidate of [requestUrl, publicOrigin]) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        // An opaque iframe's 'self' cannot authorize HTTP app assets. Permit
        // only this install's origins; validate host syntax before emitting CSP.
        if (url.protocol === "http:" && /^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/i.test(url.hostname)) {
          localOrigins.add(url.origin);
        }
      } catch { /* Invalid configuration must not broaden the policy. */ }
    }
  }
  const assetSources = ["https:", ...localOrigins].join(" ");
  return [
    `default-src ${assetSources} 'unsafe-inline' 'unsafe-eval'`,
    `img-src ${assetSources} data: blob:`,
    `font-src ${assetSources} data: blob:`,
    "connect-src 'none'",
    "frame-src https://*.pages.dev https://*.vercel.app https://*.netlify.app https://*.github.io",
    "frame-ancestors 'self'",
  ].join("; ");
}
