import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Flag, GitBranch, Plus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Condition, StoryEnding, StoryRoute, Variable, WorldDefinition } from "@yumina/engine";
import { getStoryValidationIssues } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { ConditionEditor } from "./condition-editor";
import { StyledCheckbox } from "./styled-checkbox";
import { DebouncedInput, DebouncedTextarea } from "./debounced-field";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

const inputClass = "w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all";
type Section = "routes" | "endings";

function updateField<K extends "routes" | "endings" | "settings">(key: K, value: WorldDefinition[K]) {
  useEditorStore.getState().setField(key, value);
}
function newId(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }

export function StoryStructurePanel({ section }: { section: Section }) {
  const { t } = useTranslation("editor");
  const world = useEditorStore(s => s.worldDraft);
  const locked = useEditorStore(s => s.guestMode || s.readOnlyInspect);
  const variables = world.variables ?? [];
  const routes = world.routes ?? [];
  const endings = world.endings ?? [];
  const items = section === "routes" ? routes : endings;
  const [selectedId, setSelectedId] = useState<string | null>(() => items[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const selected = items.find(item => item.id === selectedId);
  const query = search.trim().toLowerCase();
  const filtered = items.filter(item => `${item.name} ${"outcome" in item ? item.outcome : item.guidance}`.toLowerCase().includes(query));
  const issues = useMemo(() => getStoryValidationIssues(world), [world]);
  const isRoutes = section === "routes";
  const title = isRoutes ? "Routes" : "Endings";
  const singular = isRoutes ? "route" : "ending";
  const Icon = isRoutes ? GitBranch : Flag;

  function addItem() {
    const id = newId(singular);
    if (isRoutes) {
      updateField("routes", [...routes, { id, name: "New route", enabled: true, priority: 0, guidance: "", conditions: [], conditionLogic: "all", lockOnEntry: false } satisfies StoryRoute]);
    } else {
      updateField("endings", [...endings, { id, name: "New ending", enabled: false, priority: 0, routeIds: [], conditions: [], conditionLogic: "all", allowUnconditional: false, outcome: "", mode: "authored", prose: "", guidance: "" } satisfies StoryEnding]);
    }
    setSearch("");
    setSelectedId(id);
  }

  function deleteItem(id: string) {
    const remaining = items.filter(item => item.id !== id);
    if (isRoutes) updateField("routes", routes.filter(route => route.id !== id));
    else updateField("endings", endings.filter(ending => ending.id !== id));
    setSelectedId(remaining.find(item => filtered.some(match => match.id === item.id))?.id ?? remaining[0]?.id ?? null);
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-story-section={section}>
      <header className="shrink-0 border-b border-border bg-card px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-xl">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">{title}</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {isRoutes ? "Choose the active route from variable conditions." : "Disabled drafts never qualify until their fields are complete."}
            </p>
          </div>
          <button type="button" onClick={addItem} disabled={locked} className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90 disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" />Add {singular}
          </button>
        </div>
      </header>

      <div className="shrink-0 border-b border-border px-6 py-3">
        <StyledCheckbox semanticCheckbox checked={world.settings.storyStructureEnabled !== false} onChange={value => updateField("settings", { ...useEditorStore.getState().worldDraft.settings, storyStructureEnabled: value })} disabled={locked} label={t("story.structureEnabled", "Enable story routes and endings")} />
        <p className="mt-1 pl-7 text-xs text-muted-foreground">{t("story.structureEnabledHint", "Default on; disable to leave play open-ended.")}</p>
      </div>

      {issues.length > 0 && <div role="status" className="max-h-32 shrink-0 overflow-y-auto border-b border-amber-500/30 bg-amber-500/5 px-6 py-3 text-sm text-amber-200">{issues.map((issue, index) => <div key={`${issue.entityId}:${index}`}>{issue.message}</div>)}</div>}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden @[640px]:flex-row">
        <aside className={cn("flex w-full min-h-0 flex-col border-b border-border bg-sidebar @[640px]:w-80 @[640px]:shrink-0 @[640px]:border-b-0 @[640px]:border-r", selected && "hidden @[640px]:flex")} aria-label={`${title} list`}>
          <div className="shrink-0 border-b border-border p-5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/40" />
              <input type="search" aria-label={`Search ${section}`} value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${section}…`} className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-4 text-sm text-foreground shadow-inner placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none transition-all" />
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-5">
            {items.length === 0 && <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center">
              <Icon className="mx-auto h-8 w-8 text-muted-foreground/20" />
              <p className="mt-2 text-sm text-muted-foreground">No {section} yet</p>
              <p className="mt-1.5 text-xs text-muted-foreground/60">Add a {singular} to start shaping your story.</p>
            </div>}
            {filtered.map(item => <button type="button" key={item.id} data-story-item={item.id} aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)} className={cn("flex shrink-0 items-center gap-3 rounded-xl border p-3.5 text-left transition-all", selected?.id === item.id ? "border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]" : "border-transparent hover:bg-accent/50")}>
              <Icon className="h-4 w-4 shrink-0 text-primary/80" />
              <div className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm font-bold", selected?.id === item.id ? "text-primary" : "text-foreground")}>{item.name || `Untitled ${singular}`}</span>
                <span className="block truncate text-xs text-muted-foreground">{"outcome" in item ? item.outcome || (item.mode === "ai" ? "AI prose" : "Authored prose") : item.guidance || `${item.conditions.length} conditions`}</span>
              </div>
              {!item.enabled && <span className="shrink-0 text-[9px] text-muted-foreground/60">OFF</span>}
              {selected?.id === item.id && <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            </button>)}
            {items.length > 0 && filtered.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No {section} match your search.</p>}
          </div>
        </aside>

        <div data-story-scroll className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", !selected && "hidden @[640px]:block")}>
          {selected ? <div className="p-5 @[640px]:p-8 @[1000px]:p-12">
            <button type="button" onClick={() => setSelectedId(null)} className="mb-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground @[640px]:hidden"><ArrowLeft className="h-4 w-4" />Back to {section}</button>
            <article key={selected.id} data-story-detail={selected.id} className="mx-auto max-w-3xl space-y-6">
              <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-foreground">Edit {singular}</h2>
                <TwoTapDeleteButton onConfirm={() => deleteItem(selected.id)} disabled={locked} title="Delete" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10" armedChildren={<><Trash2 className="h-4 w-4" />{t("twoTapConfirm")}</>}><Trash2 className="h-4 w-4" />Delete</TwoTapDeleteButton>
              </div>
              {isRoutes ? <RoutesEditor route={selected as StoryRoute} variables={variables} disabled={locked} /> : <EndingsEditor routes={routes} ending={selected as StoryEnding} variables={variables} disabled={locked} />}
            </article>
          </div> : <div className="flex min-h-64 h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground/60"><Icon className="h-12 w-12 opacity-30" /><p className="text-sm">{items.length ? `Select a ${singular} to edit` : `Add a ${singular} to get started`}</p></div>}
        </div>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, disabled, multiline = false }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; multiline?: boolean }) {
  const C = multiline ? DebouncedTextarea : DebouncedInput;
  return <label className="block space-y-1.5"><span className="text-[13px] font-bold text-foreground">{label}</span><C value={value} onCommit={onChange} disabled={disabled} className={cn(inputClass, multiline && "min-h-28 resize-y")} /></label>;
}

function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-4 border-t border-border pt-6"><h3 className="text-sm font-bold uppercase tracking-wide text-foreground">{title}</h3>{children}</section>;
}

function Conditions({ value, logic, variables, onChange, onLogic, disabled }: { value: Condition[]; logic: "all" | "any"; variables: Variable[]; onChange: (v: Condition[]) => void; onLogic: (v: "all" | "any") => void; disabled: boolean }) {
  return <FormGroup title="Only if"><div className="flex justify-end"><div role="group" aria-label="Condition logic" className="flex rounded-lg border border-border bg-card p-1">{(["all", "any"] as const).map(option => <button type="button" key={option} disabled={disabled} aria-pressed={logic === option} onClick={() => onLogic(option)} className={cn("rounded-md px-3 py-1 text-xs font-medium transition-all disabled:opacity-50", logic === option ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{option.toUpperCase()}</button>)}</div></div><fieldset disabled={disabled}><ConditionEditor conditions={value} variables={variables} onChange={onChange} /></fieldset></FormGroup>;
}

function Priority({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  return <label className="block space-y-1.5"><span className="text-[13px] font-bold text-foreground">Priority</span><NumberInput value={value} onChange={priority => typeof priority === "number" && onChange(priority)} disabled={disabled} /></label>;
}

export function RoutesEditor({ route, variables, disabled }: { route: StoryRoute; variables: Variable[]; disabled: boolean }) {
  const set = (patch: Partial<StoryRoute>) => updateField("routes", (useEditorStore.getState().worldDraft.routes ?? []).map(item => item.id === route.id ? { ...item, ...patch } : item));
  return <>
    <TextField label="Name" value={route.name} onChange={name => set({ name })} disabled={disabled} />
    <TextField label="Guidance" value={route.guidance} onChange={guidance => set({ guidance })} disabled={disabled} multiline />
    <FormGroup title="Route settings"><Priority value={route.priority} onChange={priority => set({ priority })} disabled={disabled} /><div className="flex flex-wrap gap-4"><StyledCheckbox semanticCheckbox checked={route.enabled} onChange={enabled => set({ enabled })} disabled={disabled} label="Enabled" /><StyledCheckbox semanticCheckbox checked={route.lockOnEntry} onChange={lockOnEntry => set({ lockOnEntry })} disabled={disabled} label="Lock on entry" /></div></FormGroup>
    <Conditions value={route.conditions} logic={route.conditionLogic} variables={variables} onChange={conditions => set({ conditions })} onLogic={conditionLogic => set({ conditionLogic })} disabled={disabled} />
  </>;
}

export function EndingsEditor({ routes, ending, variables, disabled }: { routes: StoryRoute[]; ending: StoryEnding; variables: Variable[]; disabled: boolean }) {
  const set = (patch: Partial<StoryEnding>) => updateField("endings", (useEditorStore.getState().worldDraft.endings ?? []).map(item => item.id === ending.id ? { ...item, ...patch } : item));
  return <>
    <TextField label="Name" value={ending.name} onChange={name => set({ name })} disabled={disabled} />
    <TextField label="Outcome" value={ending.outcome} onChange={outcome => set({ outcome })} disabled={disabled} />
    <FormGroup title="Ending text"><div className="space-y-1.5"><span className="text-[13px] font-bold text-foreground">Writing mode</span><Select value={ending.mode} onValueChange={mode => set({ mode: mode as StoryEnding["mode"] })} disabled={disabled} options={[{ value: "authored", label: "Authored prose" }, { value: "ai", label: "AI prose" }]} /></div><TextField label={ending.mode === "ai" ? "AI guidance" : "Ending prose"} value={ending.mode === "ai" ? ending.guidance : ending.prose} onChange={value => set(ending.mode === "ai" ? { guidance: value } : { prose: value })} disabled={disabled} multiline /></FormGroup>
    <FormGroup title="Ending settings"><Priority value={ending.priority} onChange={priority => set({ priority })} disabled={disabled} /><StyledCheckbox semanticCheckbox checked={ending.enabled} onChange={enabled => set({ enabled })} disabled={disabled} label="Enabled" /></FormGroup>
    <FormGroup title="Allowed routes"><fieldset disabled={disabled} className="space-y-3">{routes.length === 0 && <p className="text-xs text-muted-foreground">No routes yet. This ending can apply to any route.</p>}{routes.map(route => <StyledCheckbox semanticCheckbox key={route.id} checked={ending.routeIds.includes(route.id)} onChange={checked => set({ routeIds: checked ? [...ending.routeIds, route.id] : ending.routeIds.filter(id => id !== route.id) })} disabled={disabled} label={route.name} />)}</fieldset></FormGroup>
    <Conditions value={ending.conditions} logic={ending.conditionLogic} variables={variables} onChange={conditions => set({ conditions })} onLogic={conditionLogic => set({ conditionLogic })} disabled={disabled} />
    <FormGroup title="Activation"><StyledCheckbox semanticCheckbox checked={ending.allowUnconditional} onChange={allowUnconditional => set({ allowUnconditional })} disabled={disabled} label="Allow unconditional activation" /><p className="text-xs text-muted-foreground">Required for an ending without conditions.</p></FormGroup>
  </>;
}
