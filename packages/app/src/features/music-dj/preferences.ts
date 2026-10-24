import { sanitizeYouTubeItems, type YouTubeMusicItem } from "./youtube-catalog";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MusicAudioMode } from "@yumina/shared";
export interface MusicDjPreferences {
  consent: boolean;
  source: "unconfigured" | "session" | "youtube";
  model: string;
  preferences: string;
  maxBgmSeconds: number;
  youtubeConsent?: boolean;
  youtubeCatalog?: YouTubeMusicItem[];
}
export const DEFAULT_MUSIC_DJ: MusicDjPreferences = { consent: false, source: "unconfigured", model: "", preferences: "", maxBgmSeconds: 600, youtubeConsent: false, youtubeCatalog: [] };
interface PreferenceState {
  accounts: Record<string, MusicDjPreferences>;
  modes: Record<string, MusicAudioMode>;
  update: (accountId: string, patch: Partial<MusicDjPreferences>) => void;
  setMode: (accountId: string, sessionId: string, mode: MusicAudioMode) => void;
}
/** Browser-local listener preferences: no card/world/export or account API write. */
export const useMusicDjPreferences = create<PreferenceState>()(persist((set) => ({
  accounts: {}, modes: {},
  update: (accountId, patch) => {
    if (!accountId) return;
    set(s => ({ accounts: { ...s.accounts, [accountId]: { ...DEFAULT_MUSIC_DJ, ...s.accounts[accountId], ...patch,
      ...(patch.youtubeCatalog !== undefined ? { youtubeCatalog: sanitizeYouTubeItems(patch.youtubeCatalog) } : {}),
      ...(patch.preferences !== undefined ? { preferences: patch.preferences.slice(0, 500) } : {}),
      ...(patch.maxBgmSeconds !== undefined ? { maxBgmSeconds: Number.isFinite(patch.maxBgmSeconds) ? Math.min(900, Math.max(60, patch.maxBgmSeconds)) : 600 } : {}),
    } } }));
  },
  setMode: (accountId, sessionId, mode) => {
    if (!accountId || !sessionId || !["creator", "personal", "off"].includes(mode)) return;
    set(s => ({ modes: Object.fromEntries([...Object.entries(s.modes).filter(([k]) => k !== `${accountId}:${sessionId}`).slice(-99), [`${accountId}:${sessionId}`, mode]]) }));
  },
}), { name: "yumina-personal-music-dj", version: 1 }));

export function listenerModeForSession(accountId: string, sessionId: string, schema: Record<string, unknown> | undefined, readOnly: boolean): MusicAudioMode {
  const root = schema?.rootComponent as { interfaceId?: string; files?: Record<string, string> } | undefined;
  const vn = root?.interfaceId !== "classic" && (root?.interfaceId === "vn" || Object.values(root?.files ?? {}).some(source => source.includes('className="vn-stage"')));
  if (!accountId || readOnly || !vn) return "creator";
  return useMusicDjPreferences.getState().modes[`${accountId}:${sessionId}`] ?? "creator";
}
