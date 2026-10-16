import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useState } from "react";
import { Image } from "lucide-react";

export function AdminImageGeneration() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/admin/image-generation", { credentials: "include" });
        const body = await response.json();
        if (!response.ok || typeof body.data?.enabled !== "boolean") throw new Error(body.error || "Could not load image generation controls.");
        if (active) setEnabled(body.data.enabled);
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "Could not load image generation controls."); }
    })();
    return () => { active = false; };
  }, []);

  const toggle = async (next: boolean) => {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/image-generation", { method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      const body = await response.json();
      if (!response.ok || typeof body.data?.enabled !== "boolean") throw new Error(body.error || "Could not save image generation controls.");
      setEnabled(body.data.enabled);
      setNotice(body.data.enabled ? "Anima and Krea are enabled. The saved setup is ready to use." : "Anima and Krea are paused. The saved setup is kept for when you re-enable them.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save image generation controls."); }
    finally { setSaving(false); }
  };

  return <section aria-labelledby="admin-image-generation-heading">
    <div className="mb-4 flex items-center gap-2"><div className="h-4 w-1 rounded-full bg-gold" aria-hidden="true" /><Image className="h-4 w-4 text-gold" aria-hidden="true" /><h2 id="admin-image-generation-heading" className="text-lg font-bold text-main">Image generation</h2></div>
    <div className="clouded-glass-panel space-y-4 rounded-2xl p-5 sm:p-6">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-main">
        <Checkbox  role="switch" checked={enabled === true} disabled={enabled === null || saving}
          onCheckedChange={checked => void toggle((checked === true))} aria-describedby="admin-image-generation-description" className="mt-1 h-5 w-5 shrink-0 accent-gold" />
        <span><span className="block font-semibold">Allow Anima and Krea image generation</span><span id="admin-image-generation-description" className="mt-1 block text-xs leading-relaxed text-sub">Applies to all users of this installation. Turn this off to keep Yumina from starting new local image jobs while you use your GPU elsewhere. Workflows, models and connection settings are saved.</span></span>
      </label>
      <p className="text-xs text-sub">{saving ? "Saving…" : enabled === null ? "Loading image generation controls…" : enabled ? "Enabled. Changes take effect immediately." : "Paused. Turn the switch on to re-enable the saved setup immediately."}</p>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="text-sm text-gold">{notice}</p>}
    </div>
  </section>;
}
