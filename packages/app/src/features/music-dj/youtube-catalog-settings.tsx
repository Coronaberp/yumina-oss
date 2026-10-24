import { DOCS_URLS } from "@/lib/docs-urls";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { makeYouTubeItem, sanitizeYouTubeItems, type YouTubeMusicItem } from "./youtube-catalog";
import type { MusicDjPreferences } from "./preferences";

interface Props { preferences: MusicDjPreferences; update: (patch: Partial<MusicDjPreferences>) => void; disabled: boolean }
const EMPTY = { id: "", name: "", link: "", type: "bgm" as "bgm" | "sfx", start: "", end: "", verified: false };
export function YouTubeCatalogSettings({ preferences, update, disabled }: Props) {
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState("");
  const items = sanitizeYouTubeItems(preferences.youtubeCatalog);
  const field = "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm";
  const change = (patch: Partial<typeof EMPTY>) => { setDraft(value => ({ ...value, ...patch, verified: false })); setError(""); };
  const save = () => {
    try {
      if (disabled) return;
      if (!draft.id && items.length >= 100) throw new Error("The personal catalog can hold up to 100 saved videos.");
      const item = makeYouTubeItem({ ...draft, id: draft.id || `yt-${crypto.randomUUID()}` });
      update({ youtubeCatalog: [...items.filter(entry => entry.id !== item.id), item] });
      setDraft(EMPTY); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Check this saved link."); }
  };
  const edit = (item: YouTubeMusicItem) => {
    setDraft({ id: item.id, name: item.name, link: `https://www.youtube.com/watch?v=${item.videoId}`, type: item.type,
      start: item.startSeconds === undefined ? "" : String(item.startSeconds), end: item.endSeconds === undefined ? "" : String(item.endSeconds), verified: item.rangeVerified });
    setError("");
  };
  return <div className="space-y-4 rounded-lg border border-border p-4">
    <h4 className="font-medium">My saved YouTube videos</h4>
    <p className="text-xs text-muted-foreground">One visible official player is used. A cue interrupts BGM and returns to its saved position. Starts, returns and loops are approximate; buffering, ads or browser autoplay rules may interrupt playback. Hiding the player pauses music.</p>
    <label className="flex cursor-pointer items-start gap-3 text-sm"><Checkbox className="mt-0.5" checked={preferences.youtubeConsent === true} disabled={disabled} onCheckedChange={checked => update({ youtubeConsent: checked === true })} /><span>I agree to enable the YouTube player under the <a className="underline" href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms</a>, <a className="underline" href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a> and <a className="underline" href={DOCS_URLS.privacyPolicy} target="_blank" rel="noopener">app privacy policy</a>. YouTube receives player/device data and video IDs. Story replies are sent only to my selected model provider.</span></label>
    <p className="text-xs text-muted-foreground">Saved links stay in this browser for your account, outside creator cards and exports. No YouTube search, API key or login is required. Link tracking parameters and URL timestamps are discarded; enter any range below yourself.</p>
    <div className="space-y-3">
      <label className="block space-y-1 text-sm"><span>Track name for the DJ</span><input className={field} maxLength={160} value={draft.name} disabled={disabled} placeholder="For example: Quiet piano, combat, impact cue" onChange={e => change({ name: e.target.value })} /></label>
      <label className="block space-y-1 text-sm"><span>YouTube video link</span><input className={field} type="text" inputMode="url" value={draft.link} disabled={disabled} placeholder="https://www.youtube.com/watch?v=…" onChange={e => change({ link: e.target.value })} /></label>
      <label className="block space-y-1 text-sm"><span>Use as</span><select aria-label="Use as" className={field} value={draft.type} disabled={disabled} onChange={e => change({ type: e.target.value as "bgm" | "sfx" })}><option value="bgm">BGM</option><option value="sfx">One-shot cue</option></select></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="min-w-0 space-y-1 text-sm"><span>Start</span><input className={field} value={draft.start} disabled={disabled} placeholder="0:00" onChange={e => change({ start: e.target.value })} /></label>
        <label className="min-w-0 space-y-1 text-sm"><span>End</span><input className={field} value={draft.end} disabled={disabled} placeholder="0:03" onChange={e => change({ end: e.target.value })} /></label>
      </div>
      <p className="text-xs text-muted-foreground">BGM can use the whole video with both fields blank, or a segment of at least five seconds. A cue requires a verified range of 30 seconds or less. Use seconds, m:ss or h:mm:ss. The DJ cannot invent a range.</p>
      <label className="flex cursor-pointer items-start gap-3 text-sm"><Checkbox className="mt-0.5" checked={draft.verified} disabled={disabled || (!draft.start && !draft.end)} onCheckedChange={checked => setDraft(value => ({ ...value, verified: checked === true }))} /><span>I checked this start/end range in the video.</span></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50" disabled={disabled} onClick={save}>{draft.id ? "Save changes" : "Add saved video"}</button>{draft.id && <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => { setDraft(EMPTY); setError(""); }}>Cancel edit</button>}</div>
    </div>
    {items.length ? <ul className="space-y-3">{items.map(item => <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3 text-sm"><div className="min-w-0 flex-1"><p className="break-words font-medium">{item.name}</p><p className="break-all text-xs text-muted-foreground">{item.type === "bgm" ? "BGM" : "Cue"} · {item.startSeconds === undefined ? "Whole video" : `${item.startSeconds}s–${item.endSeconds}s (checked)`} · <a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noopener" className="underline">Open video</a></p></div><div className="flex gap-2"><button type="button" disabled={disabled} className="underline" onClick={() => edit(item)}>Edit</button><button type="button" disabled={disabled} className="underline" onClick={() => { update({ youtubeCatalog: items.filter(entry => entry.id !== item.id) }); if (draft.id === item.id) setDraft(EMPTY); }}>Remove</button></div></li>)}</ul> : <p className="text-sm text-muted-foreground">No saved videos yet. Add links you want the DJ to choose from.</p>}
  </div>;
}
