import { useEffect, useState } from "react";
import { getParentOrigin } from "../protocol";

export const MAX_WARMED_CHAT_PORTRAITS = 24;

/** Retain only a small working set of display-sized images, never the roster. */
export function createPortraitCache(limit = MAX_WARMED_CHAT_PORTRAITS, image = () => new Image()) {
  const entries = new Map<string, HTMLImageElement>();
  return {
    get size() { return entries.size; },
    has: (url: string) => entries.has(url),
    warm(url: string) {
      if (!url || limit <= 0) return;
      let entry = entries.get(url);
      if (entry) entries.delete(url);
      else { entry = image(); entry.decoding = "async"; entry.src = url; }
      entries.set(url, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}
const portraits = createPortraitCache();

/** Only our existing CDN variant changes; external art and master refs stay exact. */
export function chatPortraitUrl(ref: string, parentOrigin: string): string {
  try {
    const parent = new URL(parentOrigin).origin;
    const url = new URL(ref, parent);
    const configured = import.meta.env?.VITE_API_URL;
    const api = configured ? new URL(configured, parent).origin : parent;
    if (![parent, api].includes(url.origin)
      || !/^\/cdn\/(?:[0-9a-f-]{36}|key\/[\w-]+)$/i.test(url.pathname)) return ref;
    url.searchParams.set("variant", "portrait");
    return ref.startsWith("/") ? url.pathname + url.search + url.hash : url.href;
  } catch { return ref; }
}

export function ChatPortrait({ src, className }: { src: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const display = chatPortraitUrl(src, getParentOrigin());
  const resolved = failed === display ? src : display;
  useEffect(() => { portraits.warm(resolved); }, [resolved]);
  return <img src={resolved} alt="" draggable={false} decoding="async" className={className}
    onError={() => { if (resolved !== src) setFailed(display); }} />;
}
