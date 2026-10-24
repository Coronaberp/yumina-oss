import type { AudioTrack } from "@yumina/engine";
import type { MusicCatalogEntry } from "@yumina/shared";

/** Small source boundary: a decision contains catalog IDs, never fetch URLs. */
export interface MusicSource {
  catalog: MusicCatalogEntry[];
  tracks: AudioTrack[];
}
export function createSessionAudioCatalog(tracks: AudioTrack[]): MusicCatalogEntry[] {
  return (Array.isArray(tracks) ? tracks : []).filter(t => t && typeof t.id === "string" && typeof t.name === "string" && typeof t.url === "string" && /^@asset:[\w-]+$/.test(t.url) && t.id.length <= 120 && (t.type === "bgm" || (t.type === "sfx" && Number.isFinite(t.maxDuration) && t.maxDuration! > 0 && t.maxDuration! <= 30)))
    .slice(0, 100).map(t => ({ id: t.id, name: t.name.slice(0, 160), type: t.type as "bgm" | "sfx", ...(t.type === "sfx" ? { startSeconds: 0, endSeconds: t.maxDuration } : {}) }));
}
export function sessionAudioSource(tracks: AudioTrack[]): MusicSource {
  const catalog = createSessionAudioCatalog(tracks);
  return { catalog, tracks: (Array.isArray(tracks) ? tracks : []).filter(t => t && catalog.some(c => c.id === t.id)).map(t => ({ ...t, preload: false })) };
}
export const youtubeSource = {
  available: true as const,
  searchAvailable: false as const,
  reason: "YouTube uses your saved links in one visible official player. Cues interrupt and then resume BGM. Search and API keys are not used.",
  search(): never { throw new Error("YouTube search disabled; use saved video links"); },
};
