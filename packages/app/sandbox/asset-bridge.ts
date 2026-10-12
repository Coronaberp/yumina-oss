import { getParentOrigin } from "./protocol";

export const SANDBOX_ASSET_READY_EVENT = "yumina:sandbox-asset-ready";
// A valid transparent image keeps image error handlers from latching a failed
// state while the parent downloads the real bytes. Fonts use their fallback.
const PENDING_ASSET = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const assets = new Map<string, { url?: string; promise: Promise<string> }>();
let loadAsset: ((url: string) => Promise<Blob>) | undefined;

export function setSandboxAssetLoader(loader: (url: string) => Promise<Blob>): void {
  loadAsset = loader;
}

function appOrigin(): string {
  const pin = getParentOrigin();
  if (pin !== "*") {
    try { return new URL(pin).origin; } catch { /* Fall back to the document. */ }
  }
  return window.location.origin === "null" ? "" : window.location.origin;
}

function absoluteAssetUrl(ref: string): string {
  if (!ref || /^(?:https?:)?\/\//i.test(ref) || /^(?:data|blob):/i.test(ref)) return ref;
  const origin = appOrigin();
  const cdnBase = (import.meta.env?.VITE_API_URL || origin).replace(/\/+$/, "");
  if (ref.startsWith("@asset:")) return `${cdnBase}/cdn/${ref.slice(7)}`;
  if (ref.startsWith("/cdn/")) return `${cdnBase}${ref}`;
  return ref.startsWith("/") ? `${origin}${ref}` : ref;
}

function bridgedAsset(ref: string): { absolute: string; entry?: { url?: string; promise: Promise<string> } } {
  if (typeof window === "undefined") return { absolute: ref };
  const absolute = absoluteAssetUrl(ref);
  if (!loadAsset) return { absolute };
  let parsed: URL;
  try { parsed = new URL(absolute); } catch { return { absolute }; }
  const origin = appOrigin();
  const apiOrigin = new URL(import.meta.env?.VITE_API_URL || origin).origin;
  if (![origin, apiOrigin].includes(parsed.origin)
    || !(parsed.pathname.startsWith("/cdn/") || parsed.pathname.startsWith("/vn-assets/"))) return { absolute };
  let entry = assets.get(absolute);
  if (!entry) {
    const current: { url?: string; promise: Promise<string> } = {
      promise: loadAsset(absolute).then(blob => {
        if (!(blob instanceof Blob)) throw new Error("Invalid asset response");
        current.url = URL.createObjectURL(blob);
        window.dispatchEvent(new Event(SANDBOX_ASSET_READY_EVENT));
        return current.url;
      }).catch(() => {
        // Preserve ordinary failure handling for missing files or expired auth.
        current.url = absolute;
        window.dispatchEvent(new Event(SANDBOX_ASSET_READY_EVENT));
        return absolute;
      }),
    };
    assets.set(absolute, current);
    entry = current;
  }
  return { absolute, entry };
}

/** Synchronous SDK URL, refreshed when a requested asset's bytes arrive. */
export function resolveSandboxAssetUrl(ref: string): string {
  const { absolute, entry } = bridgedAsset(ref);
  return entry ? entry.url || PENDING_ASSET : absolute;
}

/** Runtime DOM/font helpers can wait until a usable URL is available. */
export async function loadSandboxAssetUrl(ref: string): Promise<string> {
  const { absolute, entry } = bridgedAsset(ref);
  return entry ? entry.promise : absolute;
}

export async function resolveSandboxAssetRefs(text: string): Promise<string> {
  const refs = [...new Set(text.match(/@asset:[a-f0-9-]+/gi) || [])];
  const urls = await Promise.all(refs.map(loadSandboxAssetUrl));
  let result = text;
  refs.forEach((ref, index) => { result = result.split(ref).join(urls[index]!); });
  return result;
}
