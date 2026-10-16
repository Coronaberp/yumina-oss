import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Loader2, Trash2 } from "lucide-react";
import { feedback } from "@/lib/feedback";

const apiBase = import.meta.env.VITE_API_URL || "";
type Provider = "comfyui" | "forgeneo";
type Profile = { enabled: boolean; baseUrl: string; workflow?: string; workflowMode?: "custom" | "anima"; model?: string; hasKey: boolean; configured: boolean; adminDisabled?: boolean };
type State = { activeProvider: Provider; configs: Record<Provider, Profile> };
const defaults: Record<Provider, Profile> = {
  comfyui: { enabled: false, baseUrl: "http://127.0.0.1:8188", workflow: "", workflowMode: "custom", hasKey: false, configured: false },
  forgeneo: { enabled: false, baseUrl: "http://127.0.0.1:7860", model: "", hasKey: false, configured: false },
};

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}/api/image-sources/generation${path}`, { credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Image generation settings request failed");
  const state = body.state ?? (body.activeProvider && body.configs ? { activeProvider: body.activeProvider, configs: body.configs } : undefined);
  return { ...body, state } as { state?: State; success?: boolean; error?: string };
}

export function ImageGenerationSettings() {
  const { t } = useTranslation("settings");
  const label = (key: string, fallback: string) => t(`imageGeneration.${key}`, { defaultValue: fallback });
  const [state, setState] = useState<State>({ activeProvider: "comfyui", configs: structuredClone(defaults) });
  const [saved, setSaved] = useState<State>(state);
  const [keys, setKeys] = useState<Record<Provider, string>>({ comfyui: "", forgeneo: "" });
  const [busy, setBusy] = useState<"load" | "save" | "test" | null>("load");
  const [message, setMessage] = useState("");
  const provider = state.activeProvider;
  const profile = state.configs[provider];
  const key = keys[provider];
  const setKey = (value: string) => setKeys(current => ({ ...current, [provider]: value }));
  const savedProfile = saved.configs[provider];
  const dirty = JSON.stringify(profile) !== JSON.stringify(savedProfile) || key.trim().length > 0;
  const update = (patch: Partial<Profile>) => setState(value => ({ ...value, configs: { ...value.configs, [provider]: { ...value.configs[provider], ...patch } } }));
  const acceptSavedProfile = (incoming: State) => {
    const other = provider === "comfyui" ? "forgeneo" : "comfyui";
    setState(current => ({ ...incoming, configs: { ...incoming.configs,
      [other]: JSON.stringify(current.configs[other]) !== JSON.stringify(saved.configs[other]) ? current.configs[other] : incoming.configs[other],
    } }));
    setSaved(incoming);
  };
  const refresh = async () => {
    const body = await request("");
    if (body.state) { setState(body.state); setSaved(body.state); }
  };
  useEffect(() => {
    refresh().catch(() => setMessage(label("loadFailed", "Unable to load image generation settings"))).finally(() => setBusy(null));
    // Fetch once on mount; locale changes must preserve unsaved provider drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (kind: "save" | "test", work: () => Promise<void>) => { setBusy(kind); setMessage(""); try { await work(); } catch (error) { const text = error instanceof Error ? error.message : label("requestFailed", "Image generation settings request failed"); setMessage(text); feedback.error(text); } finally { setBusy(null); } };
  const save = () => {
    if (provider === "comfyui" && profile.enabled && profile.workflowMode !== "anima" && !(profile.workflow ?? "").includes("{{prompt}}")) { setMessage(label("workflowRequired", "ComfyUI workflow JSON must contain {{prompt}} in the positive CLIP text field.")); return; }
    void run("save", async () => {
      const body: Record<string, unknown> = { provider, enabled: profile.enabled, baseUrl: profile.baseUrl.trim(), makeActive: state.activeProvider === provider };
      if (provider === "comfyui") { body.workflowMode = profile.workflowMode ?? "custom";if (profile.workflowMode !== "anima") body.workflow = profile.workflow ?? ""; }
      else body.model = profile.model ?? "";
      if (key.trim()) body.apiKey = key.trim();
      const result = await request("", { method: "PUT", body: JSON.stringify(body) });
      if (result.state) acceptSavedProfile(result.state);
      setKey(""); setMessage(label("saved", "Image generation settings saved"));
    });
  };
  const test = () => void run("test", async () => { const result = await request("/test", { method: "POST", body: JSON.stringify({ provider }) }); if (!result.success) throw new Error(result.error || label("testFailed", "Connection test failed")); setMessage(label("testPassed", "Connection verified")); });
  const clearProfile = async () => { setBusy("save"); setMessage(""); try { const response = await request(`/${provider}`, { method: "DELETE" }); if (response.state) acceptSavedProfile(response.state); else { const next = { ...state, configs: { ...state.configs, [provider]: { ...defaults[provider] } } }; setState(next); setSaved(next); } setKey(""); } catch (error) { const text = error instanceof Error ? error.message : label("requestFailed", "Image generation settings request failed"); setMessage(text); feedback.error(text); } finally { setBusy(null); } };
  const input = "w-full min-w-0 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-sm text-main outline-none focus:border-primary/50";
  const disabled = busy !== null;
  const providerLabel = useMemo(() => provider === "comfyui" ? "ComfyUI" : "Forge Neo", [provider]);
  return <section id="settings-target-image-generation" className="profile-overview-glass profile-overview-glass--soft space-y-4 rounded-2xl p-5">
    <div className="flex items-start gap-3"><ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-main">{label("title", "Image generation")}</h3><p className="mt-1 text-xs leading-relaxed text-sub">{label("description", "Choose the default generator for the Studio agent. The creator confirms each generation before any provider request is made.")}</p></div></div>
    <div role="tablist" aria-label={label("providers", "Image providers")} className="flex flex-wrap gap-2">{(["comfyui", "forgeneo"] as Provider[]).map(item => <button key={item} type="button" role="tab" aria-selected={provider === item} disabled={disabled} onClick={() => setState(value => ({ ...value, activeProvider: item }))} className={`rounded-lg border px-3 py-2 text-sm ${provider === item ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 text-sub hover:bg-white/[0.04]"}`}>{item === "comfyui" ? "ComfyUI" : "Forge Neo"}</button>)}</div>
    <p className="text-xs text-sub">{label("defaultHint", "Saving makes the selected provider the default. Both provider profiles are kept separately.")}</p>
    {provider === "comfyui" && profile.adminDisabled && <p role="status" className="text-xs text-amber-300">{label("adminPaused", "Anima and Krea are paused by the administrator. Your saved setup is kept. Re-enable them in Administration → Image generation.")}</p>}
    <label className="flex items-start gap-2 text-sm text-main"><Checkbox  role="switch" checked={profile.enabled} disabled={disabled} onCheckedChange={checked => update({ enabled: (checked === true) })} className="mt-0.5 h-4 w-4 accent-primary" /><span><span className="block">{label("enable", `Enable ${providerLabel}`)}</span><span className="block text-xs text-sub">{provider === "comfyui" ? label("comfyHint", "Use local Anima for VN sprites with automatic background removal, or connect a custom ComfyUI workflow.") : label("forgeNeoHint", "Uses the checkpoint loaded in Forge Neo. Sprites use a green background that Yumina removes to create a transparent PNG.")}</span></span></label>
    <label className="block space-y-1 text-xs text-sub"><span>{label("baseUrl", "Base URL")}</span><input type="url" value={profile.baseUrl} disabled={disabled} onChange={e => update({ baseUrl: e.target.value })} className={input} /><span className="block text-[11px] text-sub/70">{provider === "forgeneo" ? label("forgeNeoServerHint", "Use the Forge Neo root URL and start Forge Neo with --api. Do not append /sdapi/v1.") : label("serverUrlHint", "ComfyUI must be reachable from the Yumina server. localhost refers to that machine.")}</span></label>
    {provider === "comfyui" ? <>
      <div role="tablist" aria-label={label("workflowMode", "ComfyUI workflow")} className="flex flex-wrap gap-2">
        {(["anima", "custom"] as const).map(mode => <button key={mode} type="button" role="tab" aria-selected={(profile.workflowMode ?? "custom") === mode} disabled={disabled}
          onClick={() => update({ workflowMode: mode })} className={`rounded-lg border px-3 py-2 text-xs ${(profile.workflowMode ?? "custom") === mode ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 text-sub hover:bg-white/[0.04]"}`}>
          {mode === "anima" ? label("animaMode", "Anima VN sprites") : label("customMode", "Custom workflow")}
        </button>)}
      </div>
      {profile.workflowMode === "anima" ? <p className="text-xs leading-relaxed text-sub">{label("animaHint", "Runs locally in ComfyUI with an installed Anima checkpoint, the 8-step Turbo setup, adaptive chroma selection and BiRefNet transparency extraction. Choose the Anima checkpoint on each sprite generation card.")}</p>
        : <label className="block space-y-1 text-xs text-sub"><span>{label("workflow", "Workflow JSON")}</span><textarea value={profile.workflow ?? ""} disabled={disabled} onChange={e => update({ workflow: e.target.value })} rows={6} className={`${input} font-mono text-xs`} placeholder='{"...": {"inputs": {"text": "{{prompt}}"}}' /><span className="block text-[11px] text-sub/70">{label("workflowHint", "Use an owned API-format workflow. {{prompt}} must appear in the positive CLIP text field; width and height remain workflow-controlled.")}</span></label>}
    </> : <label className="block space-y-1 text-xs text-sub"><span>{label("model", "Forge Neo checkpoint override (optional)")}</span><input value={profile.model ?? ""} disabled={disabled} onChange={e => update({ model: e.target.value })} className={input} placeholder={label("currentCheckpoint", "Use the checkpoint loaded in Forge Neo")} /></label>}
    <label className="block space-y-1 text-xs text-sub"><span>{label(provider === "forgeneo" ? "forgeAuth" : "apiKey", provider === "forgeneo" ? "Forge Neo API auth (optional)": "API key")}</span><input type="password" autoComplete="off" value={key} disabled={disabled} onChange={e => setKey(e.target.value)} className={input} placeholder={profile.hasKey ? "••••••••" : provider === "forgeneo" ? "username:password" : undefined} />{provider === "forgeneo" && <span className="block text-[11px] text-sub/70">{label("forgeAuthHint", "Leave blank unless Forge Neo was started with --api-auth. Use username:password.")}</span>}</label>
    <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={disabled} onClick={save} className="rounded-lg bg-primary/15 px-4 py-2 text-sm text-primary disabled:opacity-40">{busy === "save" ? label("saving", "Saving…") : label("save", "Save settings")}</button><button type="button" disabled={disabled || dirty || !savedProfile.configured} onClick={test} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-main disabled:opacity-40">{busy === "test" ? label("testing", "Testing…") : label("test", "Test connection")}</button><button type="button" disabled={disabled || (!profile.hasKey && !profile.baseUrl)} onClick={() => void clearProfile()} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-sub disabled:opacity-40"><Trash2 className="mr-1 inline h-4 w-4" />{label("clear", "Clear profile")}</button>{busy === "load" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}</div>
    <p className="text-xs text-sub">{provider === "forgeneo" ? profile.hasKey ? label("savedAuth", "Forge Neo authentication is saved and never shown. Enter credentials to replace it.") : label("noAuth", "No Forge Neo authentication is saved. Leave blank when the API has no authentication.") : profile.hasKey ? label("savedKey", "A key is saved and is never shown. Enter a new key only to replace it.") : label("noKey", "No key is saved yet.")}</p>{message && <p role="status" className="text-xs text-amber-300">{message}</p>}
  </section>;
}
