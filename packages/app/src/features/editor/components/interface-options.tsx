import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { interfaceKey } from "../lib/interface-presets";
import { isVnInterface } from "@yumina/engine";
import { VnTextDefaults } from "./vn-text-defaults";

export function InterfaceOptions() {
  const { t } = useTranslation("editor");
  const root = useEditorStore(state => state.worldDraft.rootComponent);
  const readOnly = useEditorStore(state => state.readOnlyInspect || state.guestMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = root ? interfaceKey(root) : "classic";
  async function choose(id: "vn" | "classic") {
    if (busy || readOnly || id === selected) return;
    setBusy(true); setError("");
    try {
      const { defaultInterface } = await import("../lib/default-interfaces");
      useEditorStore.getState().selectInterface(id, defaultInterface(id));
    } catch { setError("Could not change the layout. Try again."); }
    finally { setBusy(false); }
  }
  return <div className="max-w-4xl space-y-6 pb-8">
    <div><h2 className="text-base font-medium">{t("components.chooseLayout", "Choose a player layout")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("components.chooseLayoutHint", "Choose how your story looks. Your saved settings are kept when you switch layouts.")}</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      {(["vn", "classic"] as const).map(id => <button type="button" key={id} disabled={busy || readOnly} aria-pressed={selected === id} onClick={() => void choose(id)} className={`overflow-hidden rounded-xl border text-left disabled:opacity-60 ${selected === id ? "border-primary" : "border-border hover:border-primary/50"}`}>
        <div aria-hidden="true" className="relative h-40 border-b border-border bg-muted/30 p-5">
          {id === "vn" ? <><div className="absolute right-5 top-4 flex gap-2"><span className="h-1.5 w-5 rounded bg-primary/40" /><span className="h-1.5 w-5 rounded bg-primary/40" /><span className="h-1.5 w-5 rounded bg-primary/40" /></div><div className="mx-auto h-20 w-14 rounded-t-full bg-primary/10" /><div className="absolute inset-x-5 bottom-5 rounded-lg border border-primary/30 bg-background/70 p-3"><div className="mb-2 h-1.5 w-16 rounded bg-primary/50" /><div className="h-1.5 w-4/5 rounded bg-muted-foreground/20" /></div></> : <div className="space-y-3"><div className="ml-auto w-3/4 rounded-lg bg-primary/15 p-3"><div className="h-1.5 rounded bg-primary/40" /></div><div className="w-4/5 rounded-lg border border-border bg-background p-3"><div className="h-1.5 w-4/5 rounded bg-muted-foreground/30" /><div className="mt-2 h-1.5 w-3/5 rounded bg-muted-foreground/20" /></div><div className="h-7 rounded-lg border border-border bg-background" /></div>}
        </div>
        <div className="flex items-start justify-between gap-3 p-4"><div><span className="text-sm font-medium">{t(id === "vn" ? "components.vnLabel" : "components.classicLabel")}</span><p className="mt-1 text-xs text-muted-foreground">{t(id === "vn" ? "components.vnDescription" : "components.classicDescription")}</p></div>{selected === id && <Check size={18} className="shrink-0 text-primary" />}</div>
      </button>)}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />Changing layout…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {isVnInterface(root) && <VnTextDefaults />}
  </div>;
}
