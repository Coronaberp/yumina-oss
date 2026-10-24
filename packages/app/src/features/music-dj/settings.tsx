import { Checkbox } from "@/components/ui/checkbox";
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
  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
  return <section id="settings-target-music-dj" className="space-y-4 rounded-xl border border-border bg-card p-5">
    <h3 className="font-semibold">Personal Music DJ</h3>
    <p className="text-sm text-muted-foreground">Configure here, then choose “My music agent” in VN Settings. These preferences stay in this browser for your account and never change a creator’s card.</p>
    <label className="flex items-start gap-3 text-sm"><Checkbox className="mt-0.5" checked={preferences.consent} disabled={!accountId} onCheckedChange={checked => update(accountId, { consent: checked === true })} /><span>Allow one music decision after each completed VN reply. The complete reply is sent to my selected, already connected model provider. This may use credits or provider quota. Music failures leave the story running.</span></label>
    <label className="block space-y-1 text-sm"><span>Music source</span><select className={field} value={preferences.source} onChange={e => update(accountId, { source: e.target.value as typeof preferences.source })}>
      <option value="unconfigured">Choose a source</option><option value="session">Existing session audio assets (optional)</option><option value="youtube">YouTube (unavailable)</option>
    </select></label>
    <p className="text-xs text-muted-foreground">Existing session assets use the creator’s uploaded BGM and SFX without changing their rules. SFX require a declared duration of 30 seconds or less and play from the beginning. No dramatic timestamp is inferred.</p>
    <p role="status" className="text-xs text-muted-foreground">{youtubeSource.reason}</p>
    <label className="block space-y-1 text-sm"><span>Decision model / provider connection</span><select className={field} value={preferences.model} onChange={e => update(accountId, { model: e.target.value })}>
      <option value="">Use current story model ({selectedModel})</option>
      {preferences.model && !models.some(m => m.id === preferences.model) && <option value={preferences.model}>{preferences.model} (check connection)</option>}
      {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    <p className="text-xs text-muted-foreground">Uses your existing AI provider connection above, including its access and billing rules. No new provider credentials are collected.</p>
    <label className="block space-y-1 text-sm"><span>Musical preferences</span><textarea className={field} maxLength={500} rows={3} value={preferences.preferences} placeholder="For example: quiet instrumental music, sparse sound effects" onChange={e => update(accountId, { preferences: e.target.value })} /></label>
    <label className="block space-y-1 text-sm"><span>Maximum BGM time per selection</span><select className={field} value={preferences.maxBgmSeconds} onChange={e => update(accountId, { maxBgmSeconds: Number(e.target.value) })}><option value={300}>5 minutes</option><option value={600}>10 minutes</option><option value={900}>15 minutes</option></select></label>
    <p className="text-xs text-muted-foreground">BGM loops until its limit or a scene change. Normal changes wait 30 seconds; major scene changes wait at least 5 seconds. Pause, skip and lock take priority.</p>
  </section>;
}
