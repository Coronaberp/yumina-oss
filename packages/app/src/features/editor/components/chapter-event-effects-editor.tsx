import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ChapterEventScene, Variable, WorldEntry } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";

type Effect = ChapterEventScene["effects"][number];
const field = "min-w-0 max-w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal text-foreground";
const operations: Record<Variable["type"], Effect["operation"][]> = {
  number: ["set", "add", "subtract", "multiply"], string: ["set", "append"], boolean: ["set", "toggle"], json: ["set", "merge", "push", "delete"],
};
const operationNames: Record<Effect["operation"], string> = { set: "Set to", add: "Add", subtract: "Subtract", multiply: "Multiply by", append: "Append text", toggle: "Flip on/off", merge: "Merge object", push: "Add list item", delete: "Delete key/index" };
const defaultValue = (variable?: Variable): Effect["value"] => variable?.type === "number" ? 0 : variable?.type === "boolean" ? true : variable?.type === "json" ? {} : "";

function JsonValue({ value, onChange }: { value: Effect["value"]; onChange: (value: Effect["value"]) => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const undoEpoch = useEditorStore(s => s._undoEpoch), previousEpoch = useRef(undoEpoch);
  useEffect(() => {
    if (undoEpoch !== previousEpoch.current || document.activeElement !== ref.current) { setDraft(JSON.stringify(value)); setInvalid(false); }
    previousEpoch.current = undoEpoch;
  }, [value, undoEpoch]);
  return <div className="min-w-0 flex-1"><textarea ref={ref} aria-label="Effect JSON value" aria-invalid={invalid} value={draft} onChange={event => {
    setDraft(event.target.value);
    try {
      const parsed: unknown = JSON.parse(event.target.value);
      if (parsed === null) throw new Error("null is not an effect value");
      onChange(parsed as Effect["value"]); setInvalid(false);
    } catch { setInvalid(true); }
  }} className={`${field} min-h-20 w-full font-mono text-xs`} />{invalid && <p role="alert" className="text-xs text-destructive">Enter valid JSON. The last valid value is kept until this is fixed.</p>}</div>;
}

export function ChapterEventEffectsEditor({ effects, entryChanges, variables, entries, onChange }: {
  effects: ChapterEventScene["effects"]; entryChanges: ChapterEventScene["entryChanges"];
  variables: Variable[]; entries: WorldEntry[];
  onChange: (patch: Partial<Pick<ChapterEventScene, "effects" | "entryChanges">>) => void;
}) {
  const patchEffect = (index: number, patch: Partial<Effect>) => onChange({ effects: effects.map((effect, i) => i === index ? { ...effect, ...patch } : effect) });
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">Variable changes</h5><button type="button" disabled={!variables.length || effects.length >= 64} onClick={() => onChange({ effects: [...effects, { variableId: variables[0]!.id, operation: "set", value: defaultValue(variables[0]) }] })} className="text-xs font-medium text-primary disabled:opacity-40">+ Add effect</button></div>
    {!effects.length && <p className="text-xs text-muted-foreground">No variable changes.</p>}
    {effects.map((effect, index) => {
      const variable = variables.find(v => v.id === effect.variableId || effect.variableId.startsWith(`${v.id}.`));
      const type = variable?.type ?? "string";
      const ops = operations[type];
      return <div key={`${index}-${effect.variableId}-${effect.operation}`} className="min-w-0 space-y-2 rounded-xl border border-border bg-card/50 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select compact aria-label="Effect variable" className={`${field} flex-1`} value={effect.variableId} onValueChange={selectedValue => { const v = variables.find(v => v.id === selectedValue); patchEffect(index, { variableId: selectedValue, operation: "set", value: defaultValue(v), valueRef: undefined }); }}>
            {!variables.some(v => v.id === effect.variableId) && <option value={effect.variableId}>{effect.variableId}</option>}
            {variables.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <Select compact aria-label="Effect operation" className={field} value={effect.operation} onValueChange={selectedValue => patchEffect(index, { operation: selectedValue as Effect["operation"], valueRef: undefined, value: selectedValue === "delete" ? "" : defaultValue(variable) })}>
            {!ops.includes(effect.operation) && <option value={effect.operation}>{operationNames[effect.operation]}</option>}{ops.map(op => <option key={op} value={op}>{operationNames[op]}</option>)}
          </Select>
          <button type="button" aria-label="Remove effect" onClick={() => onChange({ effects: effects.filter((_, i) => i !== index) })} className="p-2 text-muted-foreground hover:text-destructive"><Trash2 size={16} /></button>
        </div>
        {effect.operation !== "toggle" && <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select compact aria-label="Effect value source" className={field} value={effect.valueRef !== undefined ? "variable" : "literal"} onValueChange={selectedValue => patchEffect(index, { valueRef: selectedValue === "variable" ? (variables.find(v => v.type === type)?.id ?? variables[0]?.id) : undefined })}><option value="literal">Value</option><option value="variable">From variable</option></Select>
          {effect.valueRef !== undefined ? <Select compact aria-label="Effect source variable" className={`${field} flex-1`} value={effect.valueRef} onValueChange={selectedValue => patchEffect(index, { valueRef: selectedValue })}>{variables.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
            : effect.operation === "delete" ? <input aria-label="Effect key or index" className={`${field} flex-1`} value={String(effect.value)} placeholder="Object key or list index" onChange={event => patchEffect(index, { value: event.target.value })} />
            : type === "boolean" ? <Select compact aria-label="Effect value" className={field} value={String(effect.value)} onValueChange={selectedValue => patchEffect(index, { value: selectedValue === "true" })}><option value="true">On / true</option><option value="false">Off / false</option></Select>
            : type === "json" ? <JsonValue value={effect.value} onChange={value => patchEffect(index, { value })} />
            : <input aria-label="Effect value" className={`${field} flex-1`} type={type === "number" ? "number" : "text"} step="any" value={String(effect.value)} onChange={event => { if (type !== "number" || event.target.value !== "") patchEffect(index, { value: type === "number" ? Number(event.target.value) : event.target.value }); }} />}
        </div>}
      </div>;
    })}
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">Lore and character availability</h5><button type="button" disabled={!entries.length || entryChanges.length >= 64} onClick={() => onChange({ entryChanges: [...entryChanges, { entryId: entries[0]!.id, enabled: true }] })} className="text-xs font-medium text-primary disabled:opacity-40">+ Add lore change</button></div>
    {!entryChanges.length && <p className="text-xs text-muted-foreground">No lore changes.</p>}
    {entryChanges.map((change, index) => <div key={index} className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card/50 p-3">
      <Select compact aria-label="Lore entry" className={`${field} flex-1`} value={change.entryId} onValueChange={selectedValue => onChange({ entryChanges: entryChanges.map((c, i) => i === index ? { ...c, entryId: selectedValue } : c) })}>{!entries.some(e => e.id === change.entryId) && <option value={change.entryId}>{change.entryId} (missing)</option>}{entries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select>
      <Select compact aria-label="Lore availability" className={field} value={String(change.enabled)} onValueChange={selectedValue => onChange({ entryChanges: entryChanges.map((c, i) => i === index ? { ...c, enabled: selectedValue === "true" } : c) })}><option value="true">Enable</option><option value="false">Disable</option></Select>
      <button type="button" aria-label="Remove lore change" onClick={() => onChange({ entryChanges: entryChanges.filter((_, i) => i !== index) })} className="p-2 text-muted-foreground hover:text-destructive"><Trash2 size={16} /></button>
    </div>)}
    {!!entryChanges.length && <p className="text-xs leading-relaxed text-muted-foreground">Enabling an entry still respects its lorebook, chapter and keyword gates. Disable the old character version and enable its replacement to make a lasting transformation.</p>}
  </div>;
}
