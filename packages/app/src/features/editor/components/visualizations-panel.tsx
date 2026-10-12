import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { DebouncedInput } from "./debounced-field";
import { StatusBuilder } from "./status-builder";
import { StatusDesignAssistant } from "./status-design-assistant";
import { applyStatusDrop } from "../lib/status-builder";
import { StatusLayoutPreview } from "./status-layout-preview";
import { isVnInterface } from "../lib/vn-assets";
import { initialStatusConfig, installStatusVisualization, readStatusConfig, STATUS_CONFIG_FILE } from "../lib/status-visualizations";
import type { StatusConfig, StatusField } from "../../../../../../interfaces/vn/status-data";
import { statusSourceTemplates as templates } from "../lib/status-source-templates";

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none";

export function VisualizationsPanel() {
  const { t } = useTranslation("editor");
  const root = useEditorStore(s => s.worldDraft.rootComponent);
  const worldName = useEditorStore(s => s.worldDraft.name);
  const variables = useEditorStore(s => s.worldDraft.variables);
  const updateRoot = useEditorStore(s => s.updateRootComponent);
  const setSection = useEditorStore(s => s.setActiveSection);
  const readOnly = useEditorStore(s => s.readOnlyInspect || s.guestMode);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const visibleVariables = useMemo(() => variables.filter(variable => !variable.internal), [variables]);
  const parsed = useMemo(() => {
    try { return { config: root?.files[STATUS_CONFIG_FILE] ? readStatusConfig(root.files[STATUS_CONFIG_FILE]) : initialStatusConfig(variables), error: "" }; }
    catch (error) { return { config: initialStatusConfig([]), error: error instanceof Error ? error.message : "Invalid status settings." }; }
  }, [root, variables]);
  const { config } = parsed;
  const previewValues = useMemo(() => Object.fromEntries(visibleVariables.map(variable => [variable.id, variable.defaultValue])), [visibleVariables]);
  const selected = config.fields.find(field => field.id === selectedId) ?? (selectedId ? undefined : config.fields[0]);
  const supported = isVnInterface(root);

  function commit(next: StatusConfig) {
    const currentRoot = useEditorStore.getState().worldDraft.rootComponent;
    if (!currentRoot || readOnly || parsed.error) return;
    try {
      updateRoot({ files: installStatusVisualization(currentRoot, next, templates) });
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to update status settings."); }
  }
  function mutateConfig(update: (current: StatusConfig) => StatusConfig) {
    const currentRoot = useEditorStore.getState().worldDraft.rootComponent;
    const current = currentRoot?.files[STATUS_CONFIG_FILE] ? readStatusConfig(currentRoot.files[STATUS_CONFIG_FILE]) : config;
    commit(update(current));
  }
  function changeConfig(updates: Partial<StatusConfig>) {
    mutateConfig(current => ({ ...current, ...updates }));
  }
  function changeField(updates: Partial<StatusField>) {
    if (!selected) return;
    // Debounced edits merge against the latest draft, including intervening edits.
    const currentRoot = useEditorStore.getState().worldDraft.rootComponent;
    const current = currentRoot?.files[STATUS_CONFIG_FILE] ? readStatusConfig(currentRoot.files[STATUS_CONFIG_FILE]) : config;
    commit({ ...current, fields: current.fields.map(field => field.id === selected.id ? { ...field, ...updates } : field) });
  }
  function move(direction: number) {
    if (!selected) return;
    mutateConfig(current => {
      const peers = current.fields.filter(field => field.group === selected.group);
      const from = peers.findIndex(field => field.id === selected.id), to = from + direction;
      if (from < 0 || to < 0 || to >= peers.length) return current;
      return applyStatusDrop(current, visibleVariables, `field:${selected.id}`, `field:${peers[to].id}`);
    });
  }

  if (!root || !supported) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{t("visualizations.vnRequired", "Select the Visual Novel layout in Layouts to customize its right status sheet.")}</div>;

  return <div className="space-y-5 pb-8">
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t("visualizations.title", "Player status")}</h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{t("visualizations.description", "Build the screen players see after clicking Status in the menu. Add fields, drag them into place, then choose their colors and displays. Back returns to the menu. Save your card to keep changes.")}</p>
    </div>
    {(error || parsed.error) && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error || parsed.error}</p>}
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,.85fr)]">
      <fieldset disabled={readOnly || !!parsed.error} className="min-w-0 space-y-5 disabled:opacity-60">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs text-muted-foreground">Sheet title<DebouncedInput aria-label="Sheet title" value={config.title} onCommit={title => changeConfig({ title })} className={inputClass} /></label>
          <label className="space-y-1.5 text-xs text-muted-foreground">Subtitle<DebouncedInput aria-label="Status subtitle" value={config.subtitle} onCommit={subtitle => changeConfig({ subtitle })} className={inputClass} /></label>
          <label className="flex items-center gap-3 text-xs text-muted-foreground">Accent color<input aria-label="Status accent color" type="color" value={config.accent} onChange={event => changeConfig({ accent: event.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border bg-background p-1" /></label>
        </div>
        <details className="rounded-xl border border-border p-4 space-y-3">
          <summary className="cursor-pointer text-xs font-medium">Edit categories</summary>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium">Categories</h3>
            <button type="button" disabled={config.groups.length >= 24} onClick={() => mutateConfig(current => ({ ...current,
              groups: [...current.groups, { id: `category-${crypto.randomUUID()}`, label: "New category" }] }))}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"><Plus size={13} />Add category</button>
          </div>
          {config.groups.map((group, index) => <div key={group.id} className="flex items-center gap-2">
            <DebouncedInput aria-label={`Category label ${index + 1}`} value={group.label} maxLength={80}
              onCommit={label => {
                const currentRoot = useEditorStore.getState().worldDraft.rootComponent;
                const current = currentRoot?.files[STATUS_CONFIG_FILE] ? readStatusConfig(currentRoot.files[STATUS_CONFIG_FILE]) : config;
                commit({ ...current, groups: current.groups.map(item => item.id === group.id ? { ...item, label: label.trim() || item.label } : item) });
              }} className={inputClass} />
            <TwoTapDeleteButton disabled={config.groups.length <= 1} aria-label={`Remove category ${group.label}`} onConfirm={() => {
              mutateConfig(current => {
              const groups = current.groups.filter(item => item.id !== group.id);
              const fallback = groups.find(item => item.id === "overview")?.id ?? groups[0]?.id;
              if (!fallback) return current;
              return { ...current, groups, fields: current.fields.map(field => field.group === group.id ? { ...field, group: fallback } : field) };
              });
            }} className="rounded p-2 text-destructive hover:bg-destructive/10 disabled:opacity-30" armedChildren="Remove?"><Trash2 size={15} /></TwoTapDeleteButton>
          </div>)}
          <p className="text-[11px] text-muted-foreground">These labels appear as tabs in the status sheet. Removing a category keeps its fields and assigns them to a remaining category.</p>
        </details>
        <StatusBuilder config={config} variables={visibleVariables} selectedId={selected?.id} disabled={readOnly || !!parsed.error} onSelect={setSelectedId} onDrop={(active, over) => {
          const currentRoot = useEditorStore.getState().worldDraft.rootComponent;
          const current = currentRoot?.files[STATUS_CONFIG_FILE] ? readStatusConfig(currentRoot.files[STATUS_CONFIG_FILE]) : config;
          const next = applyStatusDrop(current, visibleVariables, active, over);
          if (next === current) return;
          commit(next);
          setSelectedId(active.startsWith("field:") ? active.slice(6) : next.fields.find(field => !current.fields.some(previous => previous.id === field.id))?.id ?? "");
        }} />
        {selected && <div key={selected.id} className="space-y-4 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium">{selected.label}</h3>
            <div className="flex items-center gap-1">
              <button type="button" title="Move up" aria-label="Move field up" disabled={config.fields.filter(field => field.group === selected.group)[0]?.id === selected.id} onClick={() => move(-1)} className="rounded p-2 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowUp size={15} /></button>
              <button type="button" title="Move down" aria-label="Move field down" disabled={config.fields.filter(field => field.group === selected.group).at(-1)?.id === selected.id} onClick={() => move(1)} className="rounded p-2 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowDown size={15} /></button>
              <TwoTapDeleteButton aria-label="Remove field" onConfirm={() => mutateConfig(current => ({ ...current, fields: current.fields.filter(field => field.id !== selected.id) }))} className="rounded p-2 text-destructive hover:bg-destructive/10" armedChildren="Remove?"><Trash2 size={15} /></TwoTapDeleteButton>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-muted-foreground">Label<DebouncedInput aria-label="Field label" value={selected.label} onCommit={label => changeField({ label })} className={inputClass} /></label>
            <label className="space-y-1.5 text-xs text-muted-foreground">Variable<select aria-label="Field variable" value={selected.variableId} onChange={event => changeField({ variableId: event.target.value, path: "" })} className={inputClass}>
              <option value="">Choose a variable</option>{!visibleVariables.some(variable => variable.id === selected.variableId) && selected.variableId && <option value={selected.variableId}>Missing: {selected.variableId}</option>}{visibleVariables.map(variable => <option key={variable.id} value={variable.id}>{variable.name}</option>)}
            </select></label>
            <label className="space-y-1.5 text-xs text-muted-foreground">Display<select aria-label="Field display" value={selected.format} onChange={event => changeField({ format: event.target.value as StatusField["format"] })} className={inputClass}>
              <option value="value">Text or number</option><option value="bar">Resource bar</option><option value="segments">Attribute segments</option><option value="badges">Effect badges</option><option value="inventory">Inventory slots</option><option value="gauge">Icon gauge</option><option value="resource">Layered resource bar</option><option value="chips">Status chips</option><option value="pips">Relationship pips</option><option value="xp-ring">XP ring</option><option value="scene">Scene badge</option>
            </select></label>
            <label className="space-y-1.5 text-xs text-muted-foreground">Category<select aria-label="Field category" value={selected.group} onChange={event => changeField({ group: event.target.value as StatusField["group"] })} className={inputClass}>
              {config.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select></label>
            <label className="space-y-1.5 text-xs text-muted-foreground">Icon<DebouncedInput aria-label="Field icon" value={selected.icon} maxLength={8} onCommit={icon => changeField({ icon })} className={inputClass} /></label>
            <label className="flex items-center gap-3 text-xs text-muted-foreground">Color<input aria-label="Field color" type="color" value={selected.color} onChange={event => changeField({ color: event.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border bg-background p-1" /></label>
            <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">JSON property (optional)<DebouncedInput aria-label="Field JSON property" value={selected.path} placeholder="e.g. health.current" onCommit={path => changeField({ path })} className={inputClass} /></label>
            {selected.format === "gauge" && <label className="space-y-1.5 text-xs text-muted-foreground">Gauge shape<select aria-label="Gauge shape" value={selected.gaugeShape} onChange={event => changeField({ gaugeShape: event.target.value as StatusField["gaugeShape"] })} className={inputClass}><option value="quarter">Quarter (¼)</option><option value="half">Half (½)</option><option value="full">Full circle</option></select></label>}
            {selected.format === "pips" && <>
              <label className="space-y-1.5 text-xs text-muted-foreground">Pip shape<select aria-label="Pip shape" value={selected.pipShape} onChange={event => changeField({ pipShape: event.target.value as StatusField["pipShape"] })} className={inputClass}><option value="heart">Hearts</option><option value="star">Stars</option><option value="diamond">Diamonds</option></select></label>
              <label className="space-y-1.5 text-xs text-muted-foreground">Pip count<input aria-label="Pip count" type="number" min={1} max={20} value={selected.pipCount} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) changeField({ pipCount: Math.max(1, Math.min(20, Math.round(event.target.valueAsNumber))) }); }} className={inputClass} /></label>
            </>}
            {selected.format === "xp-ring" && <>
              <label className="space-y-1.5 text-xs text-muted-foreground">Level variable (optional)<select aria-label="Level variable" value={selected.levelVariableId} onChange={event => changeField({ levelVariableId: event.target.value, levelPath: "" })} className={inputClass}><option value="">Progress only</option>{selected.levelVariableId && !visibleVariables.some(variable => variable.id === selected.levelVariableId) && <option value={selected.levelVariableId}>Missing: {selected.levelVariableId}</option>}{visibleVariables.map(variable => <option key={variable.id} value={variable.id}>{variable.name}</option>)}</select></label>
              {selected.levelVariableId && <label className="space-y-1.5 text-xs text-muted-foreground">Level JSON property<DebouncedInput aria-label="Level JSON property" value={selected.levelPath} onCommit={levelPath => changeField({ levelPath })} className={inputClass} /></label>}
              <p className="text-xs text-muted-foreground sm:col-span-2">A brief glow plays when the bound level increases.</p>
            </>}
            {selected.format === "scene" && <label className="space-y-1.5 text-xs text-muted-foreground">Scene icon<select aria-label="Scene icon" value={selected.sceneIcon} onChange={event => changeField({ sceneIcon: event.target.value as StatusField["sceneIcon"] })} className={inputClass}><option value="auto">Match weather or time of day</option><option value="field">Use field icon</option></select></label>}
            {selected.format === "chips" && <p className="text-xs text-muted-foreground sm:col-span-2">Use effect names or objects with name, icon and remaining, expiresIn or turns. Effects with 1 or fewer remaining pulse once.</p>}
            {["bar", "segments", "gauge", "resource", "pips", "xp-ring"].includes(selected.format) && <>
              <label className="space-y-1.5 text-xs text-muted-foreground">Minimum<input aria-label="Field minimum" type="number" value={selected.min} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) changeField({ min: event.target.valueAsNumber }); }} className={inputClass} /></label>
              <label className="space-y-1.5 text-xs text-muted-foreground">Maximum<input aria-label="Field maximum" type="number" value={selected.max} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) changeField({ max: event.target.valueAsNumber }); }} className={inputClass} /></label>
              <label className="space-y-1.5 text-xs text-muted-foreground">Maximum from variable<select aria-label="Field maximum variable" value={selected.maxVariableId} onChange={event => changeField({ maxVariableId: event.target.value })} className={inputClass}><option value="">Use fixed maximum</option>{visibleVariables.map(variable => <option key={variable.id} value={variable.id}>{variable.name}</option>)}</select></label>
              {selected.maxVariableId && <label className="space-y-1.5 text-xs text-muted-foreground">Maximum JSON property<DebouncedInput aria-label="Field maximum JSON property" value={selected.maxPath} onCommit={maxPath => changeField({ maxPath })} className={inputClass} /></label>}
              {selected.max <= selected.min && !selected.maxVariableId && <p role="alert" className="text-xs text-destructive sm:col-span-2">Maximum must be greater than minimum.</p>}
            </>}
          </div>
          {!visibleVariables.some(variable => variable.id === selected.variableId) && <p className="text-xs text-muted-foreground">This field needs a variable. <button type="button" className="text-primary underline" onClick={() => setSection("variables")}>Open Variables</button></p>}
        </div>}
      </fieldset>
      <div className="min-w-0 space-y-4 self-start xl:sticky xl:top-0"><StatusLayoutPreview root={root} config={config} variables={previewValues} templates={templates} worldName={worldName} /><StatusDesignAssistant disabled={readOnly} /></div>
    </div>
  </div>;
}
