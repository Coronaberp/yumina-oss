import { useId, useState } from "react";
import { editStatusPreviewJson, emptyStatusPreviewJson, type PreviewJsonKind, type PreviewJsonPath } from "../lib/status-preview-json";
import { parseStatusPreviewInput } from "../lib/status-preview-values";

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none";
const buttonClass = "min-h-9 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted";
const kinds: { value: PreviewJsonKind; label: string }[] = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes / No" },
  { value: "group", label: "Group of fields" }, { value: "list", label: "List" }, { value: "empty", label: "Empty" },
];
function kindOf(value: unknown): PreviewJsonKind {
  return value === null || value === undefined ? "empty" : Array.isArray(value) ? "list" : typeof value === "object" ? "group"
    : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text";
}
function nameOf(key: string): string {
  if (key === "met") return "People met";
  if (key === "events") return "Recorded events";
  return key.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[._-]+/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Unnamed field";
}
function KindSelect({ value, label, onChange, collectionsOnly = false }: { value: PreviewJsonKind; label: string; onChange: (kind: PreviewJsonKind) => void; collectionsOnly?: boolean }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value as PreviewJsonKind)} className={inputClass}>
    {kinds.filter(kind => !collectionsOnly || kind.value === "group" || kind.value === "list").map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
  </select>;
}

function AddValue({ label, object, keys, onAdd }: { label: string; object: boolean; keys: string[]; onAdd: (key: string, value: unknown) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PreviewJsonKind>("text");
  const [error, setError] = useState("");
  return <div className="space-y-2 border-t border-border pt-3">
    <div className="flex min-w-0 flex-wrap gap-2">
      {object && <input aria-label={`New field in ${label}`} placeholder="New field name" value={name} maxLength={200} onChange={event => { setName(event.target.value); setError(""); }} className={`${inputClass} flex-1 basis-36`} />}
      <div className="min-w-0 flex-1 basis-32"><KindSelect label={`New ${object ? "field" : "entry"} type in ${label}`} value={kind} onChange={setKind} /></div>
      <button type="button" aria-label={`Add ${object ? "field" : "entry"} to ${label}`} className={buttonClass} onClick={() => {
        const key = name.trim();
        if (object && !key) { setError("Give the new field a name."); return; }
        if (object && keys.includes(key)) { setError("That name is already in use. Choose another name."); return; }
        onAdd(key, emptyStatusPreviewJson(kind)); setName(""); setError("");
      }}>+ Add {object ? "field" : "entry"}</button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

type NumberDraft = { path: PreviewJsonPath; text: string; error: string };
type NodeProps = {
  value: unknown; label: string; path: PreviewJsonPath; meeting?: boolean; depth: number;
  drafts: Record<string, NumberDraft>;
  collectionsOnly?: boolean;
  onEdit: (path: PreviewJsonPath, value: unknown, remove?: boolean) => void;
  onNumber: (path: PreviewJsonPath, text: string) => void;
};

function JsonValueNode({ value, label, path, meeting = false, depth, drafts, onEdit, onNumber, collectionsOnly = false }: NodeProps) {
  const inputId = useId();
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(30);
  const kind = kindOf(value), collection = kind === "list" || kind === "group";
  const number = drafts[JSON.stringify(path)];
  const entries: [string | number, unknown][] = kind === "list" ? (value as unknown[]).map((item, index) => [index, item])
    : kind === "group" ? Object.entries(value as Record<string, unknown>) : [];
  const labelElement = <label htmlFor={inputId} className="min-w-0 flex-1 break-words text-xs font-medium">{label}</label>;
  return <div className={`min-w-0 space-y-2 ${depth ? "rounded-lg border border-border p-3" : ""}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {collection ? <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${label}`} onClick={() => setOpen(!open)} className="min-h-9 min-w-0 flex-1 text-left text-xs font-medium">
        <span aria-hidden="true">{open ? "▾" : "▸"} </span>{label}<span className="ml-2 text-[10px] font-normal text-muted-foreground">{entries.length} {kind === "list" ? "entries" : "fields"}</span>
      </button> : labelElement}
      {kind === "boolean" && <button id={inputId} type="button" role="switch" aria-label={meeting ? `${label} met` : label} aria-checked={value === true} onClick={() => onEdit(path, !value)}
        className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-xs ${value ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
        <span aria-hidden="true" className={`flex h-4 w-7 items-center rounded-full px-0.5 ${value ? "bg-primary/60" : "bg-muted"}`}><span className={`h-3 w-3 rounded-full bg-foreground transition-transform ${value ? "translate-x-3" : ""}`} /></span>
        {meeting ? value ? "Met" : "Not met" : value ? "Yes" : "No"}
      </button>}
      <details className="relative shrink-0">
        <summary aria-label={`Options for ${label}`} className="flex min-h-9 cursor-pointer list-none items-center rounded px-2 text-muted-foreground">•••</summary>
        <div className="absolute right-0 z-20 w-48 space-y-2 rounded-lg border border-border bg-card p-3 shadow-xl">
          <label className="block text-[11px] text-muted-foreground">Value type</label>
          <KindSelect label={`Value type for ${label}`} value={kind} collectionsOnly={collectionsOnly && depth === 0} onChange={next => { onEdit(path, emptyStatusPreviewJson(next)); setOpen(true); }} />
          {!!path.length && <button type="button" aria-label={`Remove ${label}`} className={`${buttonClass} w-full text-destructive`} onClick={() => onEdit(path, null, true)}>Remove</button>}
        </div>
      </details>
    </div>
    {kind === "text" && <textarea id={inputId} aria-label={label} rows={2} value={String(value)} maxLength={65_536} onChange={event => onEdit(path, event.target.value)} className={`${inputClass} max-h-48 resize-y`} />}
    {kind === "number" && <>
      <input id={inputId} aria-label={label} type="text" inputMode="decimal" value={number?.text ?? String(value)} maxLength={128} aria-invalid={!!number?.error} aria-describedby={number?.error ? inputId + "-error" : undefined}
        onChange={event => onNumber(path, event.target.value)} className={inputClass} />
      {number?.error && <p id={inputId + "-error"} role="alert" className="text-xs text-destructive">Enter a valid number.</p>}
    </>}
    {kind === "empty" && <div className="space-y-2"><p className="text-xs text-muted-foreground">No value yet. Choose what to put here.</p><KindSelect label={`Value type for ${label}`} value={kind} onChange={next => { onEdit(path, emptyStatusPreviewJson(next)); setOpen(true); }} /></div>}
    {collection && open && <div className="space-y-2" role="group" aria-label={label}>
      {!entries.length && <p className="text-xs text-muted-foreground">{kind === "list" ? "No entries yet." : "No fields yet."}</p>}
      {entries.slice(0, shown).map(([key, item]) => <JsonValueNode key={`${key}:${kindOf(item)}`} value={item} label={kind === "list" ? `Entry ${Number(key) + 1}` : nameOf(String(key))} path={[...path, key]}
        meeting={path.at(-1) === "met"} depth={depth + 1} drafts={drafts} onEdit={onEdit} onNumber={onNumber} />)}
      {entries.length > shown && <button type="button" className={buttonClass} onClick={() => setShown(count => count + 30)}>Show more ({entries.length - shown} remaining)</button>}
      <AddValue label={label} object={kind === "group"} keys={entries.map(([key]) => String(key))} onAdd={(key, next) => onEdit([...path, kind === "list" ? entries.length : key], next)} />
    </div>}
  </div>;
}

export function StatusPreviewJsonEditor({ value, label, onChange, onErrorChange, collectionsOnly = false, instruction = "Change the details below, then choose Use value to update the preview." }: {
  value: unknown; label: string; onChange: (next: unknown) => void; onErrorChange: (error: string) => void;
  collectionsOnly?: boolean; instruction?: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, NumberDraft>>({});
  function updateDrafts(next: Record<string, NumberDraft>) {
    setDrafts(next); onErrorChange(Object.values(next).some(draft => draft.error) ? "Finish entering a valid number before using these values." : "");
  }
  function edit(path: PreviewJsonPath, next: unknown, remove = false) {
    const parent = remove && typeof path.at(-1) === "number" ? path.slice(0, -1) : path;
    updateDrafts(Object.fromEntries(Object.entries(drafts).filter(([, draft]) => !parent.every((key, index) => draft.path[index] === key))));
    onChange(editStatusPreviewJson(value, path, next, remove));
  }
  function editNumber(path: PreviewJsonPath, text: string) {
    const parsed = parseStatusPreviewInput("number", text);
    updateDrafts({ ...drafts, [JSON.stringify(path)]: { path, text, error: parsed.ok ? "" : parsed.error } });
    if (parsed.ok) onChange(editStatusPreviewJson(value, path, parsed.value));
  }
  return <div className="min-w-0 space-y-3" aria-label={`${label} form`}>
    <p className="text-[11px] text-muted-foreground">{instruction}</p>
    <JsonValueNode key={kindOf(value)} value={value} label={label} path={[]} depth={0} drafts={drafts} onEdit={edit} onNumber={editNumber} collectionsOnly={collectionsOnly} />
  </div>;
}
