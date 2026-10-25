import { YouTubeCatalogSettings } from "./youtube-catalog-settings";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Music2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useModelsStore } from "@/stores/models";
import { useConfigStore } from "@/stores/config";
import { DEFAULT_MUSIC_DJ, useMusicDjPreferences } from "./preferences";
import { youtubeSource } from "./source";

export function MusicDjSettings() {
  const { data } = useSession();
  const accountId = data?.user?.id ?? "";
  const preferences = useMusicDjPreferences(s => s.accounts[accountId] ?? DEFAULT_MUSIC_DJ);
  const update = useMusicDjPreferences(s => s.update);
  const models = useModelsStore(s => s.models);
  const selectedModel = useConfigStore(s => s.selectedModel);
  const field = "w-full min-w-0 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-sm text-main outline-none focus:border-primary/50";
  const trigger = "profile-overview-input-surface rounded-lg border-white/10 px-3 py-2 text-main";
  const dropdown = "profile-overview-dropdown-surface rounded-xl border border-gold/20 p-1.5 text-main shadow-2xl shadow-black/40 backdrop-blur-xl";
  return <section id="settings-target-music-dj" className="profile-overview-glass profile-overview-glass--soft space-y-4 rounded-2xl p-5">
    <div className="flex items-start gap-3">
      <Music2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-main">Personal Music DJ</h3>
        <p className="mt-1 text-xs leading-relaxed text-sub">Configure here, then choose “My music agent” in VN Settings. These preferences stay in this browser for your account and never change a creator’s card.</p>
      </div>
    </div>
    <label className="flex items-start gap-2 text-sm text-main"><Checkbox className="mt-0.5" checked={preferences.consent} disabled={!accountId} onCheckedChange={checked => update(accountId, { consent: checked === true })} /><span>Allow one music decision after each completed VN reply. The complete reply is sent to my selected, already connected model provider. This may use credits or provider quota. Music failures leave the story running.</span></label>
    <label className="block space-y-1 text-xs text-sub"><span>Music source</span><Select aria-label="Music source" triggerClassName={trigger} contentClassName={dropdown} value={preferences.source} onValueChange={value => update(accountId, { source: value as typeof preferences.source })} options={[
      { value: "unconfigured", label: "Choose a source" }, { value: "session", label: "Existing session audio assets (optional)" }, { value: "youtube", label: "YouTube saved links" },
    ]} /></label>
    <p className="text-xs text-sub">Existing session assets use the creator’s uploaded BGM and SFX without changing their rules. SFX require a declared duration of 30 seconds or less and play from the beginning. No dramatic timestamp is inferred.</p>
    {preferences.source === "youtube" && <><p className="text-xs text-sub">{youtubeSource.reason}</p><YouTubeCatalogSettings preferences={preferences} update={patch => update(accountId, patch)} disabled={!accountId} /></>}
    <label className="block space-y-1 text-xs text-sub"><span>Decision model / provider connection</span><Select aria-label="Decision model / provider connection" triggerClassName={trigger} contentClassName={dropdown} value={preferences.model} onValueChange={value => update(accountId, { model: value })} options={[
      { value: "", label: `Use current story model (${selectedModel})` },
      ...(preferences.model && !models.some(m => m.id === preferences.model) ? [{ value: preferences.model, label: `${preferences.model} (check connection)` }] : []),
      ...models.map(model => ({ value: model.id, label: model.name })),
    ]} /></label>
    <p className="text-xs text-sub">Uses your existing AI provider connection above, including its access and billing rules. No new provider credentials are collected.</p>
    <label className="block space-y-1 text-xs text-sub"><span>Musical preferences</span><textarea className={field} maxLength={500} rows={3} value={preferences.preferences} placeholder="For example: quiet instrumental music, sparse sound effects" onChange={e => update(accountId, { preferences: e.target.value })} /></label>
    <label className="block space-y-1 text-xs text-sub"><span>Maximum BGM time per selection</span><Select aria-label="Maximum BGM time per selection" triggerClassName={trigger} contentClassName={dropdown} value={preferences.maxBgmSeconds} onValueChange={value => update(accountId, { maxBgmSeconds: Number(value) })} options={[{ value: "300", label: "5 minutes" }, { value: "600", label: "10 minutes" }, { value: "900", label: "15 minutes" }]} /></label>
    <p className="text-xs text-sub">BGM loops until its limit or a scene change. Normal changes wait 30 seconds; major scene changes wait at least 5 seconds. Pause, skip and lock take priority.</p>
  </section>;
}
