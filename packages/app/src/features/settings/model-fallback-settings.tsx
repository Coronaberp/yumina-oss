import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, ExternalLink, Pencil, Plus, ShieldCheck } from "lucide-react";
import { DEFAULT_MODEL_FALLBACK_POLICY, formatModelId, modelFallbackText, type ModelFallbackMode } from "@yumina/shared";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { useIsLocalEdition } from "@/edition/edition";
import { ModelBrowser } from "@/features/chat/model-browser";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUserProfileStore } from "@/stores/user-profile";
import { NewProfileForm, ProfileEditor, type ApiKeyEntry } from "./api-keys";

const apiBase = import.meta.env?.VITE_API_URL || "";
function profileModel(profile: ApiKeyEntry): string {
  const model = profile.metadata?.defaultModel?.trim() ?? "";
  return !model || profile.provider === "openrouter" || model.startsWith(`${profile.provider}/`)
    ? model : `${profile.provider}/${model}`;
}


export function ModelFallbackSettings() {
  const { i18n, t: translate } = useTranslation("profile");
  const storedPolicy = useConfigStore((s) => s.modelFallback);
  const setConfig = useConfigStore((s) => s.setConfig);
  const provider = useCreditStore((s) => s.provider);
  const localEdition = useIsLocalEdition();
  const privateMode = localEdition || provider === "private";
  const accountId = useUserProfileStore((s) => s.profile?.id);
  const policy = storedPolicy ?? DEFAULT_MODEL_FALLBACK_POLICY;
  const [profiles, setProfiles] = useState<ApiKeyEntry[]>([]);
  const [loadedAccount, setLoadedAccount] = useState<string | undefined | null>(null);
  const loading = loadedAccount !== accountId;
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ModelFallbackMode | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProvider, setCreateProvider] = useState("custom");
  const current = !loading ? profiles.find(profile => profile.id === policy.privateKeyId) : undefined;
  const editedProfile = profiles.find(profile => profile.id === editing);
  const model = privateMode ? current ? policy.privateModel : "" : policy.officialModel;
  const t = (key: Parameters<typeof modelFallbackText>[1]) => modelFallbackText(i18n.language, key);
  const label = (key: string, fallback: string) => translate(`contentEndpoints.${key}`, { defaultValue: fallback });
  const loadProfiles = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/keys`, { credentials: "include", signal });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.data)) throw new Error("Could not load backup provider profiles.");
    return body.data as ApiKeyEntry[];
  }, []);
  useEffect(() => {
    if (!privateMode) return;
    const controller = new AbortController();
    void loadProfiles(controller.signal).then(rows => {
      if (!controller.signal.aborted) { setProfiles(rows); setError(null); }
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load backup provider profiles.");
    }).finally(() => { if (!controller.signal.aborted) setLoadedAccount(accountId); });
    return () => controller.abort();
  }, [accountId, privateMode, loadProfiles]);
  useEffect(() => {
    if (!privateMode || !current?.metadata?.defaultModel) return;
    const configuredModel = profileModel(current);
    if (configuredModel !== policy.privateModel) setConfig("modelFallback", { ...policy, privateModel: configuredModel });
  }, [privateMode, current, policy, setConfig]);
  const assign = (profile: ApiKeyEntry | null) => {
    const saved = useConfigStore.getState().modelFallback ?? DEFAULT_MODEL_FALLBACK_POLICY;
    const nextModel = profile ? profileModel(profile) : "";
    if (profile && !nextModel) { setEditing(profile.id); return; }
    setConfig("modelFallback", { ...saved, privateKeyId: profile?.id ?? null, privateModel: nextModel });
  };
  const refresh = async (id?: string) => {
    try {
      const rows = await loadProfiles(); setProfiles(rows); setLoadedAccount(accountId); setError(null);
      if (id) { const row = rows.find(profile => profile.id === id); if (row) assign(row); }
      return rows;
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load backup provider profiles."); return []; }
  };
  return (
    <section id="model-fallback" className="scroll-mt-6 border-b border-white/[0.06] pb-5" aria-labelledby="model-fallback-settings-title">
      <h3 id="model-fallback-settings-title" className="flex items-center gap-2 text-sm font-medium text-main"><ArrowRightLeft className="h-4 w-4 text-gold" aria-hidden="true" />{t("settingsTitle")}</h3>
      <p className="mt-1 text-xs text-sub">{t("settingsBody")}</p>
      <label className="mt-3 block text-xs font-medium text-main" htmlFor="model-fallback-mode">{t("mode")}</label>
      <Select id="model-fallback-mode" value={policy.mode} onValueChange={value => {
        const mode = value as ModelFallbackMode;
        if (!privateMode && mode === "auto" && !model) { setPendingMode(mode); setPickerOpen(true); return; }
        setConfig("modelFallback", { ...policy, mode });
      }} options={[{value:"ask",label:t("ask")},{value:"auto",label:t("auto")},{value:"stop",label:t("stopMode")}]} triggerClassName="profile-overview-input-surface mt-1.5 border-gold/20 text-main" contentClassName="profile-overview-dropdown-surface rounded-xl border border-gold/20 p-1.5 text-main shadow-2xl shadow-black/40 backdrop-blur-xl" />
      {privateMode ? <section className="profile-overview-glass profile-overview-glass--soft mt-3 rounded-2xl p-5" aria-labelledby="backup-provider-title">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="backup-provider-title" className="flex items-center gap-2 text-sm font-semibold text-main"><ShieldCheck className="h-5 w-5 shrink-0 text-primary" />{label("backupTitle", "Backup provider")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-sub">{label("backupDescription", "Story uses this connection and its model if your selected model is unavailable. Content routing still applies.")}</p>
          </div>
          {current && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">{label("configured", "Configured")}</span>}
        </div>
        <Select aria-label={label("backupTitle", "Backup provider")} value={current?.id ?? "__none__"} onValueChange={id => assign(profiles.find(profile => profile.id === id) ?? null)} disabled={loading} options={[
          {value:"__none__",label:label("unconfigured", "Not configured")},
          ...(!loading ? profiles : []).map(profile => ({value:profile.id,label:profile.label || profile.id,description:profile.baseUrl || profile.metadata?.defaultModel || profile.provider})),
        ]} triggerClassName="profile-overview-input-surface mt-4 rounded-lg border-white/10 px-3 py-2 text-main" contentClassName="profile-overview-dropdown-surface rounded-xl border border-gold/20 p-1.5 text-main shadow-2xl shadow-black/40 backdrop-blur-xl" />
        {current ? <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs text-sub [overflow-wrap:anywhere]">
          <div className="flex items-center gap-2 font-medium text-main"><span className="truncate">{current.label}</span><span className="text-muted-foreground/50">·</span><span className="shrink-0">{current.provider}</span></div>
          {current.baseUrl && <div className="flex items-start gap-1 break-all"><ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />{current.baseUrl}</div>}
          <div>{label("model", "Model")}: <span className="break-words text-main/80">{current.metadata?.defaultModel || formatModelId(model)}</span></div>
        </div> : <p className="mt-3 text-xs text-sub">{label("backupEmpty", "No backup provider selected.")}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {current && <Button type="button" variant="outline" size="sm" className="rounded-lg border-white/10 text-main" disabled={loading} onClick={() => setEditing(current.id)}><Pencil />{label("edit", "Edit profile")}</Button>}
          <Button type="button" variant="outline" size="sm" className="rounded-lg border-white/10 text-main" disabled={loading} onClick={() => { setCreateProvider("custom"); setCreateOpen(true); }}><Plus />{label("create", "Create profile")}</Button>
        </div>
      </section> : <button type="button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog" className="profile-overview-input-surface mt-2 flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border border-gold/20 px-3 py-2 text-left text-main transition-colors hover:border-gold/50">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span className="text-xs text-sub">{t("backup")}</span><span className="break-words text-xs font-medium">{model ? formatModelId(model) : t("empty")}</span></span>
      </button>}
      {!loading && error && <p role="alert" className="mt-2 text-xs text-destructive">{error} <button type="button" className="underline" onClick={() => void refresh()}>{label("retry", "Retry")}</button></p>}
      <div className="mt-2 space-y-1 text-[11px] text-sub"><p>{privateMode ? label("backupBilling", "Backup usage is billed by the selected provider. Its price and writing style may differ.") : t("billing")}</p><p>{t("autoNote")}</p></div>
      {!privateMode && <ModelBrowser open={pickerOpen} onClose={() => { setPickerOpen(false); setPendingMode(null); }} selectionOnly selectedModel={model} onSelect={id => {
        setConfig("modelFallback", { ...policy, mode: pendingMode ?? policy.mode, officialModel: id }); setPickerOpen(false); setPendingMode(null);
      }} />}
      <Dialog open={createOpen || !!editing} onOpenChange={open => { if (!open) { setCreateOpen(false); setEditing(null); } }}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{label("backupTitle", "Backup provider")}</DialogTitle><DialogDescription>{label("backupEditDescription", "Configure the connection and model for backup Story attempts.")}</DialogDescription></DialogHeader>
          {createOpen ? <>
            <Select aria-label="Provider type" value={createProvider} onValueChange={setCreateProvider} options={["custom","openrouter","anthropic","openai","google","ollama"].map(value => ({value,label:translate(`apiKeys.providers.${value}`,{defaultValue:value})}))} />
            <NewProfileForm key={createProvider} provider={createProvider} initialLabel={label("backupTitle", "Backup provider")} onCancel={() => setCreateOpen(false)} onCreated={async id => { await refresh(); setCreateOpen(false); setEditing(id); }} />
          </> : editedProfile && <ProfileEditor key={editedProfile.id} entry={editedProfile} isActive={false} isNsfwActive={false} assignmentBusy={false} manageOnly onToggleActive={() => {}} onToggleNsfw={() => {}} onDelete={() => {}} onSaved={async () => { const rows = await refresh(editedProfile.id); if (rows.find(row => row.id === editedProfile.id)?.metadata?.defaultModel) setEditing(null); }} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
