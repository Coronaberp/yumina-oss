import { useEffect, useMemo, useRef, useState } from "react";
import type { RootComponent, Variable } from "@yumina/engine";
import { Copy, Upload } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useEditorStore } from "@/stores/editor";
import type { StatusConfig } from "../../../../../../interfaces/vn/status-data";
import { MAX_STATUS_DESIGN_BYTES, prepareStatusDesign, statusDesignInstructions } from "../lib/status-design-import";
import { StatusLayoutPreview } from "./status-layout-preview";

type Candidate = { id: string; base: RootComponent; root: RootComponent; owner: string; worldId: string | null };
const buttonClass = "flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-40";

export function StatusDesignImport({ root, variables, config, templates, worldName, previewValues, category, disabled }: {
  root: RootComponent; variables: Variable[]; config: StatusConfig; templates: Record<string, string>;
  worldName: string; previewValues: Record<string, unknown>; category: string; disabled: boolean;
}) {
  const { data: session, isPending } = useSession();
  const owner = session?.user.id ?? "";
  const worldId = useEditorStore(state => state.serverWorldId);
  const [source, setSource] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [validation, setValidation] = useState({ ready: false, error: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [loadingFile, setLoadingFile] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileVersion = useRef(0);
  useEffect(() => { const version = fileVersion; version.current++; return () => { version.current++; }; }, [owner, worldId]);
  const instructions = useMemo(() => statusDesignInstructions(worldName, variables, config, root, previewValues), [worldName, variables, config, root, previewValues]);
  const stale = !!candidate && (candidate.base !== root || candidate.owner !== owner || candidate.worldId !== worldId);
  function editSource(value: string) { fileVersion.current++; setLoadingFile(null); setSource(value); setCandidate(null); setValidation({ ready: false, error: "" }); setError(""); setNotice(""); }
  async function copy() {
    try { await navigator.clipboard.writeText(instructions); setNotice("Design instructions copied, including all variable definitions and current Status settings."); }
    catch { setShowInstructions(true); setNotice("Select and copy the instructions below."); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    const version = ++fileVersion.current;
    setLoadingFile(null);
    setCandidate(null); setValidation({ ready: false, error: "" }); setError(""); setNotice("");
    if (file.size > MAX_STATUS_DESIGN_BYTES) { setError("Import one JSON or TSX file smaller than 256 KB."); return; }
    setLoadingFile(version);
    try {
      const text = await file.text();
      if (version === fileVersion.current) editSource(text);
    } catch { if (version === fileVersion.current) setError("This file could not be read. Try pasting its contents."); }
    finally { setLoadingFile(current => current === version ? null : current); }
  }
  function preview() {
    setError(""); setNotice(""); setCandidate(null); setValidation({ ready: false, error: "" });
    try {
      const state = useEditorStore.getState();
      if (disabled || isPending || !owner || state.readOnlyInspect || state.guestMode || state.editingLocked || state.worldDraft.rootComponent !== root || state.serverWorldId !== worldId) throw new Error("The card or account changed. Reopen Visualizations and try again.");
      setCandidate({ id: crypto.randomUUID(), base: root, root: prepareStatusDesign(root, source), owner, worldId });
    } catch (error) { setError(error instanceof Error ? error.message : "This design could not be prepared."); }
  }
  function apply() {
    const state = useEditorStore.getState();
    if (!candidate || !validation.ready || validation.error || disabled || isPending || loadingFile !== null || stale || candidate.owner !== owner || state.readOnlyInspect || state.guestMode || state.editingLocked || state.serverWorldId !== candidate.worldId || state.worldDraft.rootComponent !== candidate.base) {
      setError("The card or preview changed. Preview the design again before applying it."); return;
    }
    state.updateRootComponent({ files: { ...state.worldDraft.rootComponent.files, "status-layout.tsx": candidate.root.files["status-layout.tsx"] } });
    setCandidate(null); setSource(""); setNotice("Design applied to your card. Undo is available; normal card autosave still applies.");
  }
  return <section aria-label="Import Status design" className="min-w-0 space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
    <h3 className="text-sm font-medium">Bring a design from another chatbot</h3>
    <p className="text-xs leading-relaxed text-muted-foreground">Copy your card’s instructions and variables to the other chatbot. Paste its complete JSON or TSX result here, check the preview, then apply it.</p>
    <button type="button" onClick={() => void copy()} className={buttonClass}><Copy size={14} />Copy design instructions</button>
    <details open={showInstructions} onToggle={event => setShowInstructions(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">View design instructions</summary>
      {showInstructions && <textarea readOnly aria-label="Design instructions and variable JSON" value={instructions} rows={10} className="mt-2 w-full min-w-0 resize-y rounded-lg border border-border bg-background p-3 font-mono text-[11px]" />}
    </details>
    <details>
      <summary className="cursor-pointer text-xs font-medium">Paste or upload a design</summary>
      <div className="mt-3 space-y-3">
        <input ref={fileInput} type="file" accept=".json,.tsx,.jsx,.ts,.txt,application/json,text/plain" className="hidden" aria-label="Status design file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} />
        <button type="button" disabled={disabled || isPending || !owner} onClick={() => fileInput.current?.click()} className={buttonClass}><Upload size={14} />Upload design file</button>
        <textarea aria-label="Paste Status design" value={source} onChange={event => editSource(event.target.value)} disabled={disabled} rows={7} maxLength={MAX_STATUS_DESIGN_BYTES} spellCheck={false} placeholder="Paste the complete TSX component or Yumina Status design JSON." className="w-full min-w-0 resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs focus:border-primary focus:outline-none" />
        <button type="button" disabled={disabled || isPending || loadingFile !== null || !owner || !source.trim()} onClick={preview} className={`${buttonClass} bg-primary text-primary-foreground`}>{loadingFile !== null ? "Reading design file…" : "Check and preview design"}</button>
        <p className="text-[11px] text-muted-foreground">Checking and previewing leave your card unchanged. Import replaces only the Status content after Apply.</p>
        {candidate && <div className="space-y-3">
          <StatusLayoutPreview key={candidate.id} root={candidate.root} config={config} variables={previewValues} templates={templates} worldName={worldName} category={category} label="Imported design preview" onValidationChange={setValidation} />
          {validation.error && <p role="alert" className="break-words text-xs text-destructive">{validation.error}</p>}
          {stale && <p role="alert" className="text-xs text-destructive">Your card changed while this preview was open. Check and preview again before applying.</p>}
          <p className="text-xs text-muted-foreground">{validation.ready && !stale ? "Preview loaded. Check each category and try different preview values before applying." : "Waiting for a working preview…"}</p>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || isPending || stale || !validation.ready || !!validation.error} onClick={apply} className={`${buttonClass} bg-primary text-primary-foreground`}>Apply design</button><button type="button" onClick={() => { setCandidate(null); setValidation({ ready: false, error: "" }); }} className={buttonClass}>Cancel preview</button></div>
        </div>}
      </div>
    </details>
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  </section>;
}
