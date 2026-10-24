import { useId, useMemo, useState, type ChangeEvent } from "react";
import type { Variable } from "@yumina/engine";
import { Select } from "@/components/ui/select";
import { StatusPreviewJsonEditor } from "./status-preview-json";
import { variableDataType } from "../lib/variable-data";
import {
  STATUS_PREVIEW_INPUT_LIMIT, clearStatusPreviewOverride, filterStatusPreviewVariables,
  formatStatusPreviewInput, parseStatusPreviewInput, setStatusPreviewOverride, statusPreviewValue, statusPreviewRequirements, describeStatusPreviewRequirement,
} from "../lib/status-preview-values";

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none";
type Props = {
  variables: Variable[];
  /** Starting values; overrides are layered on top. These objects are never mutated. */
  values: Record<string, unknown>;
  overrides: Record<string, unknown>;
  onOverridesChange: (next: Record<string, unknown>) => void;
};

function PreviewValueRow({ variable, variables, value, resetValue, overridden, requirements, onApply, onReset }: {
  variable: Variable; value: unknown; resetValue: unknown; overridden: boolean;
  variables: Variable[];
  requirements: ReturnType<typeof statusPreviewRequirements>;
  onApply: (next: unknown, withRequirements: boolean) => void; onReset: () => void;
}) {
  const inputId = useId(), errorId = useId();
  const formatted = formatStatusPreviewInput(variable.type, value);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [formRevision, setFormRevision] = useState(0);
  const changed = draft !== formatted;
  const dataType = variableDataType(variable);
  const typeLabel = {number:"Number",string:"Text",boolean:"Yes / No",list:"List",group:"Group of fields",choice:"Text with valid options"}[dataType];
  const jsonDraft = useMemo(() => variable.type === "json" ? parseStatusPreviewInput("json", draft) : null, [variable.type, draft]);
  function apply(withRequirements = false) {
    if (formError) { setError(formError); return; }
    if (variable.type === "string" && variable.enumValues !== undefined && !variable.enumValues.includes(draft)) { setError("Choose one of the valid options."); return; }
    const parsed = parseStatusPreviewInput(variable.type, draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(""); onApply(parsed.value, withRequirements);
  }
  function reset() { setDraft(formatStatusPreviewInput(variable.type, resetValue)); setError(""); setFormError(""); setFormRevision(revision => revision + 1); onReset(); }
  const common = {
    id: inputId, value: draft, "aria-invalid": !!error, "aria-describedby": error ? errorId : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setDraft(event.target.value); setError(""); setFormError(""); setFormRevision(revision => revision + 1); },
  };
  return <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
    <label htmlFor={inputId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs font-medium">
      <span className="break-words">{variable.name || variable.id}</span>
      <span className="text-[10px] font-normal text-muted-foreground">{typeLabel}{variable.internal ? " · hidden/internal" : ""}{variable.enabled === false ? " · disabled" : ""}{overridden ? " · preview override" : ""}</span>
    </label>
    <p className="break-all text-[10px] text-muted-foreground">{variable.id}</p>
    <div className="sticky top-0 z-10 flex flex-wrap gap-2 border-b border-border bg-card py-2">
      <button type="button" disabled={!changed || !!formError} onClick={() => apply()} className="min-h-9 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40">Use value</button>
      {requirements.overrides && <button type="button" disabled={!!formError} onClick={() => apply(true)} className="min-h-9 rounded-lg border border-primary/50 px-3 py-2 text-xs font-medium text-primary disabled:opacity-40">Show in preview</button>}
      <button type="button" disabled={!overridden && !changed && !error && !formError} onClick={reset} className="min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground disabled:opacity-40">Reset value</button>
    </div>
    {variable.type === "boolean" ? <Select id={inputId} compact aria-label={variable.name || variable.id} value={draft} onValueChange={value => { setDraft(value); setError(""); }} className={inputClass}>
      {draft !== "true" && draft !== "false" && <option value="">Choose a value</option>}
      <option value="true">Yes</option><option value="false">No</option>
    </Select> : variable.type === "number" ? <input {...common} type="text" inputMode="decimal" maxLength={128} className={inputClass} />
      : variable.type === "string" && variable.enumValues !== undefined ? <Select id={inputId} aria-label={variable.name || variable.id} compact value={draft} onValueChange={value=>{setDraft(value);setError("");}} className={inputClass}>
        {!variable.enumValues.includes(draft) && <option value={draft} disabled>{draft ? `Current value: ${draft} (choose an option)` : "Choose an option"}</option>}
        {variable.enumValues.map(value=><option key={value} value={value}>{value || "(empty text)"}</option>)}
      </Select> : variable.type === "json" ? <>
        {jsonDraft?.ok ? <StatusPreviewJsonEditor key={formRevision} label={variable.name || variable.id} value={jsonDraft.value} onErrorChange={setFormError} onChange={next => {
          const text = formatStatusPreviewInput("json", next);
          if (text.length > STATUS_PREVIEW_INPUT_LIMIT) { const message = "This preview value is too large. Remove an entry before adding more."; setError(message); setFormError(message); setFormRevision(revision => revision + 1); return; }
          setDraft(text); setError("");
        }} /> : <p className="text-xs text-muted-foreground">Finish editing the data in Advanced, or reset this value to use the form.</p>}
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
          <p className="my-2 text-[11px] text-muted-foreground">Edit the raw JSON directly.</p>
          <textarea {...common} aria-label={`Advanced data for ${variable.name || variable.id}`} rows={6} maxLength={STATUS_PREVIEW_INPUT_LIMIT} spellCheck={false} className={`${inputClass} max-h-64 resize-y font-mono`} />
        </details>
      </> : <textarea {...common} rows={2} maxLength={STATUS_PREVIEW_INPUT_LIMIT} className={`${inputClass} max-h-64 resize-y`} />}
    {variable.type === "number" && (variable.min !== undefined || variable.max !== undefined) && <p className="text-[10px] text-muted-foreground">Usual range: {variable.min ?? "no minimum"} to {variable.max ?? "no maximum"}. You can try values outside this range.</p>}
    {!requirements.active && <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
      <p>{variable.activation?.mode === "conditions" && variable.activation.conditionLogic === "any" ? "This item needs at least one of the following before it can appear:" : "This item needs the following before it can appear:"}</p>
      {requirements.conditions.filter(item => !item.satisfied).map((item, index) => <p key={index} className="break-words">{describeStatusPreviewRequirement(item, variables)}</p>)}
      <p>{requirements.overrides ? "Show in preview uses your value and fills in the details above. It won’t change your saved game." : "Find these values with the search box above and change them to try this item. Your design may also have other rules for when items appear."}</p>
    </div>}
    {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function StatusPreviewValues({ variables, values, overrides, onOverridesChange }: Props) {
  const [query, setQuery] = useState("");
  const [resetEpoch, setResetEpoch] = useState(0);
  const matches = useMemo(() => filterStatusPreviewVariables(variables, query), [variables, query]);
  const effectiveValues = useMemo(() => ({ ...values, ...overrides }), [values, overrides]);
  const overrideCount = variables.filter(variable => Object.hasOwn(overrides, variable.id)).length;
  return <details className="min-w-0 rounded-xl border border-border p-4">
    <summary className="cursor-pointer text-xs font-medium">Try preview values{overrideCount ? ` · ${overrideCount} changed` : ""}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">Try different values to see how your Status screen looks. These changes won’t affect your saved card or game.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Search preview variables" placeholder="Search name, ID or type" value={query} onChange={event => setQuery(event.target.value)} className={`${inputClass} flex-1 basis-40`} />
        <button type="button" disabled={!variables.length} onClick={() => { onOverridesChange({}); setResetEpoch(epoch => epoch + 1); }} className="min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground disabled:opacity-40">Reset all values</button>
      </div>
      <p role="status" className="text-[11px] text-muted-foreground">{matches.length} of {variables.length} variables · includes hidden/internal variables</p>
      <div className="max-h-[min(40dvh,24rem)] space-y-3 overflow-y-auto overscroll-contain">
        {matches.map(variable => <PreviewValueRow key={`${variable.id}:${variable.type}:${resetEpoch}:${formatStatusPreviewInput(variable.type, statusPreviewValue(variable, values, overrides))}`} variable={variable} variables={variables}
          value={statusPreviewValue(variable, values, overrides)} resetValue={Object.hasOwn(values, variable.id) ? values[variable.id] : variable.defaultValue} overridden={Object.hasOwn(overrides, variable.id)}
          requirements={statusPreviewRequirements(variable, variables, effectiveValues)}
          onApply={(value, withRequirements) => {
            const next = setStatusPreviewOverride(overrides, variable.id, value);
            const required = withRequirements ? statusPreviewRequirements(variable, variables, { ...values, ...next }).overrides : null;
            onOverridesChange({ ...next, ...required });
          }}
          onReset={() => onOverridesChange(clearStatusPreviewOverride(overrides, variable.id))} />)}
        {!matches.length && <p className="py-4 text-xs text-muted-foreground">{variables.length ? "No variables match your search." : "This card has no variables yet."}</p>}
      </div>
    </div>
  </details>;
}
