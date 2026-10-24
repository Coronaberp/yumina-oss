import { validateMusicDecision, type MusicCatalogEntry } from "@yumina/shared";
import type { MusicDjPreferences } from "./preferences";
const apiBase = import.meta.env?.VITE_API_URL || "";
export async function requestMusicDecision(sessionId: string, reply: string, catalog: MusicCatalogEntry[], preferences: MusicDjPreferences, model: string, currentTrackId: string | null, signal: AbortSignal) {
  if (!preferences.consent || (preferences.source !== "session" && !(preferences.source === "youtube" && preferences.youtubeConsent))) throw new Error("Music source is not configured");
  const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/completions`, {
    method: "POST", credentials: "include", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: preferences.model || model, musicDj: { optIn: true, reply, catalog, preferences: preferences.preferences, currentTrackId } }),
  });
  if (!response.ok) throw new Error("Music provider unavailable");
  const body = await response.text();
  let decision: unknown;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const event = block.match(/^event: ?(.+)$/m)?.[1];
    const raw = block.match(/^data: ?(.+)$/m)?.[1];
    if (!raw) continue;
    if (event === "error") throw new Error("Music decision unavailable");
    if (event === "done") decision = JSON.parse(raw).musicDecision;
  }
  return validateMusicDecision(decision, catalog);
}
