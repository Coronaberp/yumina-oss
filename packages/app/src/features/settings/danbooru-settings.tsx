import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Loader2, Unplug } from "lucide-react";
import { feedback } from "@/lib/feedback";

const apiBase = import.meta.env.VITE_API_URL || "";
type DanbooruConfig = { enabled: boolean; username: string; hasKey: boolean; configured: boolean };

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}/api/image-sources/danbooru${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Danbooru settings request failed");
  return body as { config?: DanbooruConfig; success?: boolean; error?: string };
}

export function DanbooruSettings() {
  const { t } = useTranslation("settings");
  const label = (key: string, fallback: string) => t(`danbooru.${key}`, { defaultValue: fallback });
  const [config, setConfig] = useState<DanbooruConfig>({ enabled: false, username: "", hasKey: false, configured: false });
  const [savedConfig, setSavedConfig] = useState<DanbooruConfig>(config);
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "test" | "disconnect" | null>("load");
  const [message, setMessage] = useState("");

  const refresh = async () => {
    const body = await request("");
    if (body.config) {
      setConfig(body.config);
      setSavedConfig(body.config);
      setUsername(body.config.username);
    }
  };
  useEffect(() => {
    refresh().catch(() => {
      setMessage(label("loadFailed", "Unable to load Danbooru settings"));
    }).finally(() => setBusy(null));
    // Settings are fetched once when this panel mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (kind: Exclude<typeof busy, "load" | null>, work: () => Promise<void>) => {
    setBusy(kind); setMessage("");
    try { await work(); }
    catch (error) {
      const text = error instanceof Error ? error.message : label("requestFailed", "Danbooru settings request failed");
      setMessage(text); feedback.error(text);
    }
    finally { setBusy(null); }
  };

  const save = () => {
    const nextUsername = username.trim();
    const hasNextKey = apiKey.trim().length > 0 || config.hasKey;
    if ((nextUsername.length > 0 || hasNextKey) && (!nextUsername || !hasNextKey)) {
      setMessage(label("credentialsRequired", "Enter both a Danbooru username and API key, or leave both blank for anonymous search."));
      return;
    }
    void run("save", async () => {
      const body: Record<string, unknown> = { enabled: config.enabled, username: nextUsername };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const result = await request("", { method: "PUT", body: JSON.stringify(body) });
      if (result.config) { setConfig(result.config); setSavedConfig(result.config); setUsername(result.config.username); }
      setApiKey("");
      setMessage(label("saved", "Danbooru settings saved"));
    });
  };

  const test = () => void run("test", async () => {
    const result = await request("/test", { method: "POST", body: "{}" });
    if (!result.success) throw new Error(result.error || label("testFailed", "Danbooru connection test failed"));
    setMessage(label("testPassed", "Danbooru connection verified"));
  });

  const disconnect = () => void run("disconnect", async () => {
    const result = await request("", { method: "DELETE" });
    const next = result.config ?? { enabled: false, username: "", hasKey: false, configured: false };
    setConfig(next); setSavedConfig(next); setUsername(""); setApiKey("");
    setMessage(label("disconnected", "Danbooru credentials cleared"));
  });

  const input = "w-full min-w-0 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-sm text-main outline-none focus:border-primary/50";
  const disabled = busy !== null;
  const dirty = config.enabled !== savedConfig.enabled || username.trim() !== savedConfig.username || apiKey.trim().length > 0;
  return <section id="settings-target-danbooru" className="profile-overview-glass profile-overview-glass--soft space-y-4 rounded-2xl p-5">
    <div className="flex items-start gap-3">
      <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-main">{label("title", "Danbooru artwork search")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-sub">{label("description", "Let the Studio agent search and import existing Danbooru artwork for sprites and backgrounds. Danbooru is an artwork source, not an image generator.")}</p>
      </div>
    </div>
    <label className="flex items-start gap-2 text-sm text-main">
      <Checkbox  role="switch" checked={config.enabled} disabled={disabled} onCheckedChange={(checked) => setConfig((value) => ({ ...value, enabled: (checked === true) }))} className="mt-0.5 h-4 w-4 accent-primary" />
      <span><span className="block">{label("enable", "Allow Danbooru searches")}</span><span className="block text-xs text-sub">{label("enableHint", "Anonymous search works with both credential fields empty; credentials enable authenticated access.")}</span></span>
    </label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-1 text-xs text-sub"><span>{label("username", "Danbooru username")}</span><input value={username} disabled={disabled} onChange={(e) => setUsername(e.target.value)} className={input} autoComplete="username" /></label>
      <label className="block space-y-1 text-xs text-sub"><span>{label("apiKey", "Danbooru API key")}</span><input type="password" value={apiKey} disabled={disabled} onChange={(e) => setApiKey(e.target.value)} className={input} autoComplete="off" placeholder={config.hasKey ? "••••••••" : undefined} /></label>
    </div>
    <a href="https://danbooru.donmai.us/profile" target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-primary underline">{label("profileLink", "Get your API key from your Danbooru profile")}</a>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled} onClick={save} className="rounded-lg bg-primary/15 px-4 py-2 text-sm text-primary disabled:opacity-40">{busy === "save" ? label("saving", "Saving…") : label("save", "Save settings")}</button>
      <button type="button" disabled={disabled || !savedConfig.configured || dirty} onClick={test} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-main disabled:opacity-40">{busy === "test" ? label("testing", "Testing…") : label("test", "Test connection")}</button>
      <button type="button" disabled={disabled} onClick={disconnect} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-sub disabled:opacity-40"><Unplug className="h-4 w-4" />{busy === "disconnect" ? label("disconnecting", "Clearing…") : label("disconnect", "Clear credentials")}</button>
      {busy === "load" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
    </div>
    <p className="text-xs text-sub">{config.hasKey ? label("savedKey", "An API key is saved. It is never shown here; enter a new key only to replace it.") : label("noKey", "No API key saved. Leave both fields empty for anonymous search.")}</p>
    {message && <p role="status" className="text-xs text-amber-300">{message}</p>}
  </section>;
}
