import { useState } from "react";
import type { Variable } from "@yumina/engine";
import { listToChoices } from "../lib/variable-data";

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground";
const buttonClass = "min-h-9 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground";

export function VariableChoices({variable,onChange}: {variable:Variable;onChange:(update:Partial<Variable>)=>void}) {
  const [draft,setDraft]=useState("");
  const [error,setError]=useState("");
  const options=variable.enumValues ?? [];
  return <div className="space-y-3 rounded-xl border border-border p-4">
    <h3 className="text-sm font-bold">Valid options</h3>
    <p className="text-xs text-muted-foreground">This variable holds one text value. Choose its starting value from these options.</p>
    {!options.length && <p className="text-xs text-muted-foreground">Add the choices below.</p>}
    <ul className="max-h-56 space-y-2 overflow-y-auto">
      {options.map((option,index)=><li key={index} className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 break-words text-sm">{option || "(empty text)"}</span>
        <button type="button" aria-label={`Remove option ${option || "empty text"}`} className={buttonClass} onClick={()=>onChange({enumValues:options.filter((_,i)=>i!==index)})}>Remove</button>
      </li>)}
    </ul>
    <div className="flex flex-wrap gap-2">
      <input aria-label="New valid option" placeholder="e.g. Friendly" value={draft} maxLength={1000} onChange={e=>{setDraft(e.target.value);setError("");}} className={`${inputClass} flex-1 basis-40`} />
      <button type="button" className={buttonClass} onClick={()=>{
        const next=draft.trim();
        if(!next){setError("Enter an option to add.");return;}
        if(options.includes(next)){setError("That option is already in the list.");return;}
        if(options.length>=500){setError("Use up to 500 options.");return;}
        onChange({enumValues:[...options,next]});setDraft("");setError("");
      }}>Add option</button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!options.includes(String(variable.defaultValue)) && <p className="text-xs text-destructive">Choose a starting value from the list. Your current value has been kept.</p>}
  </div>;
}

export function ListChoicesConversion({variable,onChange}: {variable:Variable;onChange:(update:Partial<Variable>)=>void}) {
  const list=variable.defaultValue;
  const [starting,setStarting]=useState(Array.isArray(list) && typeof list[0]==="string" ? list[0] : "");
  const update=listToChoices(list,starting);
  if(!update) return null;
  return <div className="space-y-3 rounded-xl border border-border p-4">
    <h3 className="text-sm font-bold">Did you mean a set of choices?</h3>
    <p className="text-xs text-muted-foreground">A List stores every entry together. If this value should be just one option, turn it into Text with valid options.</p>
    <label className="block space-y-2 text-xs">Starting choice
      <select aria-label="Starting choice for conversion" className={inputClass} value={starting} onChange={e=>setStarting(e.target.value)}>
        {(update.enumValues ?? []).map(value=><option key={value} value={value}>{value || "(empty text)"}</option>)}
      </select>
    </label>
    <button type="button" className={buttonClass} onClick={()=>onChange(update)}>Use this list as valid options</button>
  </div>;
}
