import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Save } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { customUiName, interfaceKey, type InterfacePreset } from "../lib/interface-presets";

const apiBase = import.meta.env.VITE_API_URL || "";
type Choice = { id: string; label: string; description: string; preset?: InterfacePreset };

export function InterfacePicker() {
  const { t } = useTranslation("editor");
  const root = useEditorStore(s => s.worldDraft.rootComponent);
  const drafts = useEditorStore(s => s.worldDraft.interfaceDrafts);
  const selectInterface = useEditorStore(s => s.selectInterface);
  const [library, setLibrary] = useState<InterfacePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveId = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const abort = new AbortController();
    fetch(`${apiBase}/api/custom-ui-presets`, { credentials: "include", cache: "no-store", signal: abort.signal })
      .then(async res => { if (!res.ok) throw new Error(t("components.libraryFailed")); return res.json(); })
      .then(({ data }) => setLibrary(data))
      .catch(e => { if (!abort.signal.aborted) setError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [t]);

  const selected = root ? interfaceKey(root) : "classic";
  const choices = useMemo(() => {
    const result: Choice[] = [
      { id: "vn", label: t("components.vnLabel"), description: t("components.vnDescription") },
      { id: "classic", label: t("components.classicLabel"), description: t("components.classicDescription") },
    ];
    for (const preset of library) result.push({ id: `custom:${preset.id}`, label: preset.name, description: t("components.customDescription", { count: Object.keys(preset.files).length }), preset });
    for (const [id, draft] of Object.entries(drafts ?? {})) {
      if (!result.some(c => c.id === id)) result.push({ id, label: draft.name, description: t("components.cardCustomDescription"), preset: draft });
    }
    if (root && !result.some(c => c.id === selected)) result.push({ id: selected, label: root.name, description: t("components.cardCustomDescription"), preset: root });
    return result;
  }, [drafts, library, root, selected, t]);
  const selectedChoice = choices.find(c => c.id === selected)!;
  const filtered = choices.filter(c => `${c.label} ${c.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const highlightedId = filtered[highlighted]?.id;
  useEffect(() => {
    if (open && highlightedId) document.getElementById(`${listId}-${highlightedId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedId, listId, open]);

  const choose = async (choice: Choice) => {
    setOpen(false); setQuery(""); setError("");
    if (choice.id === selected) return;
    setBusy(true);
    try {
      const preset = choice.preset ?? (await import("../lib/default-interfaces")).defaultInterface(choice.id as "vn" | "classic");
      selectInterface(choice.id, preset);
    } catch { setError(t("components.interfaceFailed")); }
    finally { setBusy(false); }
  };

  const save = async () => {
    const savedName = customUiName(name);
    if (!savedName || saving) return;
    const { worldDraft } = useEditorStore.getState();
    const snapshot = worldDraft.rootComponent;
    if (!snapshot) return;
    setSaving(true); setSaveError("");
    try {
      const response = await fetch(`${apiBase}/api/custom-ui-presets`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: saveId.current, name: savedName, files: snapshot.files, entryFile: snapshot.entryFile }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("components.saveUiFailed"));
      const saved = body.data as InterfacePreset;
      setLibrary(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      const current = useEditorStore.getState().worldDraft;
      if (current.id === worldDraft.id && current.rootComponent?.updatedAt === snapshot.updatedAt) selectInterface(`custom:${saved.id}`, saved);
      setSaveOpen(false);
    } catch (e) { setSaveError(e instanceof Error ? e.message : t("components.saveUiFailed")); }
    finally { setSaving(false); }
  };

  return <div className="space-y-1.5">
    <label htmlFor={`${listId}-input`} className="block text-xs font-medium text-muted-foreground">{t("components.interface")}</label>
    <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
      <div className="relative min-w-0 flex-1 basis-full sm:basis-auto" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(""); }
      }}>
        <input id={`${listId}-input`} ref={input} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open && filtered[highlighted] ? `${listId}-${filtered[highlighted].id}` : undefined}
          value={open ? query : selectedChoice?.label ?? ""} disabled={busy} placeholder={t("components.searchInterfaces")}
          onFocus={() => { setOpen(true); setQuery(""); setHighlighted(0); }} onClick={() => setOpen(true)}
          onChange={event => { setQuery(event.target.value); setHighlighted(0); setOpen(true); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); setOpen(false); setQuery(""); }
            else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true);
              setHighlighted(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (open && filtered[highlighted]) void choose(filtered[highlighted]); else setOpen(true);
            }
          }}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-9 text-sm text-foreground focus:border-primary focus:outline-none" />
        <button type="button" aria-label={t("components.openInterfaces")} tabIndex={-1} disabled={busy}
          onMouseDown={event => event.preventDefault()} onClick={() => { if (open) { setOpen(false); setQuery(""); } else { input.current?.focus(); setOpen(true); } }}
          className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center text-muted-foreground">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {open && <div id={listId} role="listbox" aria-label={t("components.interface")} className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
          {filtered.map((choice, index) => <button id={`${listId}-${choice.id}`} key={choice.id} type="button" role="option" aria-selected={choice.id === selected} tabIndex={-1}
            onMouseDown={event => event.preventDefault()} onClick={() => void choose(choice)} onMouseMove={() => setHighlighted(index)}
            className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent", index === highlighted && "bg-accent")}>
            <span className="min-w-0 flex-1"><span className="block break-words text-foreground">{choice.label}</span><span className="block text-xs text-muted-foreground">{choice.description}</span></span>
            {choice.id === selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </button>)}
          {!filtered.length && <p className="px-3 py-3 text-sm text-muted-foreground">{t("components.noInterfaces")}</p>}
          {loading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("components.loadingInterfaces")}</p>}
        </div>}
      </div>
      <button type="button" disabled={!root || busy || loading} onClick={() => {
        setName(root?.name ?? ""); setSaveError(""); saveId.current = crypto.randomUUID(); setSaveOpen(true);
      }} className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50">
        <Save className="h-4 w-4" />{t("components.saveCustomUiFiles")}
      </button>
    </div>
    <p className="text-xs text-muted-foreground">{selectedChoice?.description}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={saveOpen} onOpenChange={value => { if (!saving) setSaveOpen(value); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t("components.saveCustomUiFiles")}</DialogTitle><DialogDescription>{t("components.saveUiHint")}</DialogDescription></DialogHeader>
        <div className="space-y-2">
          <label htmlFor={`${listId}-name`} className="block text-xs font-medium text-muted-foreground">{t("components.customUiName")}</label>
          <input id={`${listId}-name`} autoFocus value={name} disabled={saving} onChange={event => { setName(event.target.value); setSaveError(""); }}
            onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void save(); } }}
            aria-describedby={`${listId}-name-hint`} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none" />
          <p id={`${listId}-name-hint`} className="text-xs text-muted-foreground">{t("components.nameLimitHint")} <span className="tabular-nums">{Array.from(name.trim()).length}/50</span></p>
          {Array.from(name.trim()).length > 50 && <p className="break-words text-xs text-muted-foreground">{t("components.savedNamePreview", { name: customUiName(name) })}</p>}
          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        </div>
        <DialogFooter>
          <button type="button" disabled={saving} onClick={() => setSaveOpen(false)} className="rounded-lg border border-border px-3 py-2 text-xs">{t("components.cancel")}</button>
          <button type="button" disabled={!customUiName(name) || saving} onClick={() => void save()} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t(saving ? "components.savingUi" : "components.saveUi")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
