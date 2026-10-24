import type { MusicCatalogEntry } from "@yumina/shared";

export interface YouTubeMusicItem {
  id: string;
  name: string;
  videoId: string;
  type: "bgm" | "sfx";
  startSeconds?: number;
  endSeconds?: number;
  rangeVerified: boolean;
}
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Parse identifiers only. No URL from this input is ever fetched. */
export function parseYouTubeLink(input: string): string {
  const value = input.trim();
  if (VIDEO_ID.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a YouTube video link or video ID."); }
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || /^https:\/\/[^/]*:\d+/i.test(value)) throw new Error("Use a normal HTTPS YouTube video link.");
  let id: string | null = null;
  if (["youtu.be", "www.youtu.be"].includes(url.hostname)) id = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1] ?? null;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)\/?$/)?.[1] ?? null;
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error("That link does not identify a supported YouTube video.");
  return id;
}
export function parseYouTubeTime(raw: string | number | undefined): number | undefined {
  if (raw === undefined || String(raw).trim() === "") return undefined;
  const value = String(raw).trim();
  const parts = value.split(":");
  if (parts.length > 3 || !parts.every((p, i) => i === parts.length - 1 ? /^\d+(?:\.\d+)?$/.test(p) : /^\d+$/.test(p)) || parts.slice(1).some(p => Number(p) >= 60)) throw new Error("Use seconds, m:ss, or h:mm:ss.");
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) throw new Error("Timestamps must be within 24 hours.");
  return seconds;
}
export function makeYouTubeItem(input: { id: string; name: string; link: string; type: "bgm" | "sfx"; start?: string | number; end?: string | number; verified: boolean }): YouTubeMusicItem {
  if (!/^[\w-]{1,100}$/.test(input.id) || !input.name.trim() || input.name.length > 160 || !["bgm", "sfx"].includes(input.type)) throw new Error("Add a short name for this saved video.");
  const startSeconds = parseYouTubeTime(input.start), endSeconds = parseYouTubeTime(input.end);
  const hasRange = startSeconds !== undefined || endSeconds !== undefined;
  if (hasRange && (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds)) throw new Error("Enter both start and end, with end after start.");
  if ((hasRange || input.type === "sfx") && !input.verified) throw new Error("Confirm that you checked this cue range in the video.");
  if (input.type === "bgm" && hasRange && endSeconds! - startSeconds! < 5) throw new Error("A BGM segment must be at least five seconds to avoid rapid repeats.");
  if (input.type === "sfx" && (!hasRange || endSeconds! - startSeconds! > 30)) throw new Error("A one-shot cue needs a verified range of 30 seconds or less.");
  return { id: input.id, name: input.name.trim(), videoId: parseYouTubeLink(input.link), type: input.type, rangeVerified: hasRange && input.verified,
    ...(hasRange ? { startSeconds, endSeconds } : {}) };
}
/** Validate persisted browser data again before offering anything to the agent. */
export function sanitizeYouTubeItems(raw: unknown): YouTubeMusicItem[] {
  if (!Array.isArray(raw)) return [];
  const items = new Map<string, YouTubeMusicItem>();
  for (const item of raw.slice(0, 100)) {
    try {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.videoId !== "string") continue;
      const safe = makeYouTubeItem({ id: item.id, name: item.name, link: item.videoId, type: item.type, start: item.startSeconds, end: item.endSeconds, verified: item.rangeVerified === true });
      if (!items.has(safe.id)) items.set(safe.id, safe);
    } catch { /* Invalid/tampered local records are unavailable, never fetched. */ }
  }
  return [...items.values()];
}
export function youtubeCatalog(raw: unknown): MusicCatalogEntry[] {
  return sanitizeYouTubeItems(raw).map(item => ({ id: item.id, name: item.name, type: item.type,
    ...(item.type === "sfx" ? { startSeconds: item.startSeconds, endSeconds: item.endSeconds } : {}) }));
}
