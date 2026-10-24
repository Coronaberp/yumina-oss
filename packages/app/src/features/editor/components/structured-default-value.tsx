import { useState } from "react";
import type { Variable } from "@yumina/engine";
import { StatusPreviewJsonEditor } from "./status-preview-json";
import { JsonDefaultValueEditor } from "./json-default-value-editor";
import { jsonDefaultText, jsonDefaultUpdate, parseJsonDefault } from "../lib/json-default";

function DefaultForm({variable,onChange}: {variable:Variable;onChange:(update:Partial<Variable>)=>void}) {
  const [draft,setDraft]=useState(variable.defaultValue);
  const [error,setError]=useState("");
  const [formError,setFormError]=useState("");
  const [revision,setRevision]=useState(0);
  const serialized=JSON.stringify(draft,null,2);
  let invalidSource=false;
  try{parseJsonDefault(jsonDefaultText(variable));}catch{invalidSource=true;}
  const changed=serialized!==JSON.stringify(variable.defaultValue,null,2) || invalidSource;
  return <div className="space-y-3">
    <div className="sticky top-0 z-10 flex flex-wrap gap-2 bg-card py-2">
      <button type="button" disabled={!changed || !!error || !!formError} onClick={()=>onChange(jsonDefaultUpdate(serialized))} className="min-h-9 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40">Use starting value</button>
      <button type="button" disabled={!changed && !error && !formError} onClick={()=>{setDraft(variable.defaultValue);setError("");setFormError("");setRevision(value=>value+1);}} className="min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground disabled:opacity-40">Discard changes</button>
    </div>
    <StatusPreviewJsonEditor key={revision} value={draft} label={variable.name || variable.id} collectionsOnly
      instruction="Edit the list or fields below, then choose Use starting value. This sets the value for new games."
      onErrorChange={setFormError} onChange={value=>{
        if(JSON.stringify(value).length>65_536){setError("This value is too large. Remove an entry before adding more.");setRevision(value=>value+1);return;}
        // Saved collection defaults require an object or array; nested values may use any JSON type.
        if(!value || typeof value!=="object"){setError("Choose List or Group of fields for this variable.");return;}
        setDraft(value as Record<string,unknown> | unknown[]);setError("");
      }} />
    {invalidSource && <p className="text-xs text-muted-foreground">Advanced contains unfinished data. Use this form to replace it, or finish it in Advanced.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
  </div>;
}

export function StructuredDefaultValue(props: {
  variable:Variable;onChange:(update:Partial<Variable>)=>void;expanded:boolean;onExpandedChange:(expanded:boolean)=>void;
}) {
  return <div className="space-y-3">
    <DefaultForm key={jsonDefaultText(props.variable)} variable={props.variable} onChange={props.onChange}/>
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
      <p className="my-3 text-xs text-muted-foreground">Edit the raw JSON directly.</p>
      <JsonDefaultValueEditor {...props}/>
    </details>
  </div>;
}
