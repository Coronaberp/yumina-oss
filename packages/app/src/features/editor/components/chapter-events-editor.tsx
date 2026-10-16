import { Select } from "@/components/ui/select";
import { useState } from "react";
import { ArrowUp, ArrowDown, ListOrdered, Plus, Trash2 } from "lucide-react";
import { chapterEventSchema, chapterEventSceneSchema, type ChapterEvent, type ChapterEventScene } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { Checkbox } from "@/components/ui/checkbox";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { DebouncedInput, DebouncedTextarea } from "./debounced-field";
import { ConditionEditor } from "./condition-editor";
import { ChapterEventEffectsEditor } from "./chapter-event-effects-editor";
import { cn } from "@/lib/utils";

const field = "w-full min-w-0 rounded-xl border border-border bg-card px-4 py-3 text-sm font-normal text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50";
const label = "block space-y-2 text-sm font-semibold";
const button = "flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
function move<T>(items: T[], index: number, direction: number) {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
}

export function ChapterEventsEditor({ chapterId }: { chapterId: string }) {
  const world = useEditorStore(s => s.worldDraft);
  const locked = useEditorStore(s => s.guestMode || s.readOnlyInspect);
  const events = world.chapters?.find(c => c.id === chapterId)?.events ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const selected = events.find(e => e.id === selectedId) ?? events[0];
  const scene = selected?.scenes.find(s => s.id === sceneId) ?? selected?.scenes[0];
  const eventIndex = events.findIndex(e => e.id === selected?.id);
  const sceneIndex = selected?.scenes.findIndex(s => s.id === scene?.id) ?? -1;

  // Resolve every nested write against the latest draft. A delayed field commit
  // cannot resurrect a removed event/scene or overwrite a concurrent agent edit.
  function updateEvents(update: (events: ChapterEvent[]) => ChapterEvent[]) {
    const store = useEditorStore.getState();
    if (store.guestMode || store.readOnlyInspect) return;
    store.setChapters((store.worldDraft.chapters ?? []).map(c => c.id === chapterId ? { ...c, events: update(c.events ?? []) } : c));
  }
  function patchEvent(update: (event: ChapterEvent) => ChapterEvent) {
    if (selected) updateEvents(list => list.map(e => e.id === selected.id ? update(e) : e));
  }
  function patchScene(update: (scene: ChapterEventScene) => ChapterEventScene) {
    if (scene) patchEvent(e => ({ ...e, scenes: e.scenes.map(s => s.id === scene.id ? update(s) : s) }));
  }
  function addEvent() {
    const event = chapterEventSchema.parse({ id: id("event"), name: `Event ${events.length + 1}`, scenes: [{ id: id("scene"), name: "Scene 1" }] });
    updateEvents(list => [...list, event]); setSelectedId(event.id); setSceneId(null);
  }
  const effectsProps = { variables: world.variables, entries: world.entries.filter(e => e.role !== "greeting") };

  return <section className="min-w-0 space-y-4 border-t border-border pt-6" aria-label="Chapter events" data-chapter-events>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-bold"><ListOrdered size={16} />Events</h3><button type="button" disabled={locked || events.length >= 32} className={button} onClick={addEvent}><Plus size={14} />Add event</button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">Build major sequences inside this chapter. Prerequisites start an event; its scenes run in order. Required moments are checked against the story before lasting effects apply once. One event runs at a time, in the order below.</p>
    {!events.length && <div className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No events yet. Add one for a mission, turning point or character transformation.</div>}
    {!!events.length && <div className="grid grid-cols-1 gap-2 @[480px]:grid-cols-2" aria-label="Events">{events.map((event, index) => <button type="button" key={event.id} title={event.name} aria-pressed={selected?.id === event.id} onClick={() => { setSelectedId(event.id); setSceneId(null); }} className={cn("flex min-w-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-left text-sm font-medium", selected?.id === event.id ? "border-primary/30 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent")}><span className="shrink-0">{index + 1}.</span><span className="truncate">{event.name}</span>{!event.enabled && <span className="shrink-0 text-xs text-muted-foreground">· Draft</span>}</button>)}</div>}
    {selected && <div key={selected.id} className="min-w-0 space-y-5 rounded-xl border border-border bg-card/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold">Event details</h4><div className="flex items-center gap-2">
        <button type="button" className={button} aria-label="Move event earlier" disabled={locked || eventIndex <= 0} onClick={() => updateEvents(list => move(list, list.findIndex(e => e.id === selected.id), -1))}><ArrowUp size={14} /></button>
        <button type="button" className={button} aria-label="Move event later" disabled={locked || eventIndex === events.length - 1} onClick={() => updateEvents(list => move(list, list.findIndex(e => e.id === selected.id), 1))}><ArrowDown size={14} /></button>
        <TwoTapDeleteButton disabled={locked} onConfirm={() => updateEvents(list => list.filter(e => e.id !== selected.id))} className="p-2 text-xs font-medium text-destructive hover:bg-destructive/10" armedChildren="Confirm delete"><Trash2 size={14} className="inline mr-1" />Delete event</TwoTapDeleteButton>
      </div></div>
      <label className={label}>Event name<DebouncedInput aria-label="Event name" maxLength={200} value={selected.name} onCommit={name => patchEvent(e => ({ ...e, name }))} className={field} /></label>
      <label className="flex items-center gap-2 text-sm font-medium"><Checkbox disabled={locked} checked={selected.enabled} onCheckedChange={checked => patchEvent(e => ({ ...e, enabled: checked === true }))} />Enable event</label>
      <p className="text-xs leading-relaxed text-muted-foreground">Keep this off while drafting. Once enabled, the event starts when this chapter is active and its prerequisites are met. Disabling pauses saved progress; enabling resumes it.</p>
      <label className={label}>Author notes<DebouncedTextarea aria-label="Event notes" maxLength={8000} value={selected.description} onCommit={description => patchEvent(e => ({ ...e, description }))} className={`${field} min-h-20`} placeholder="Optional overview for you. Put playable directions in each scene below." /></label>
      <div className="min-w-0 space-y-3 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold">Prerequisites</h4><Select compact aria-label="Prerequisite matching" className="rounded-lg border border-border bg-card p-2 text-xs" value={selected.conditionLogic} onValueChange={selectedValue => patchEvent(e => ({ ...e, conditionLogic: selectedValue as "all" | "any" }))}><option value="all">Meet all conditions</option><option value="any">Meet any condition</option></Select></div><p className="text-xs text-muted-foreground">No conditions means the event can start immediately. Prerequisites are checked only when it starts.</p><ConditionEditor label="Start conditions" conditions={selected.conditions} variables={world.variables} onChange={conditions => patchEvent(e => ({ ...e, conditions }))} /></div>
      <div className="min-w-0 space-y-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold">Ordered scenes</h4><button type="button" className={button} disabled={locked || selected.scenes.length >= 40} onClick={() => { const added = chapterEventSceneSchema.parse({ id: id("scene"), name: `Scene ${selected.scenes.length + 1}` }); patchEvent(e => ({ ...e, scenes: [...e.scenes, added] })); setSceneId(added.id); }}><Plus size={14} />Add scene</button></div>
        {!selected.scenes.length && <p className="text-xs text-muted-foreground">Add at least one scene before enabling this event.</p>}
        <div className="grid grid-cols-1 gap-2 @[480px]:grid-cols-2" aria-label="Event scenes">{selected.scenes.map((item, index) => <button type="button" key={item.id} title={item.name} aria-pressed={scene?.id === item.id} onClick={() => setSceneId(item.id)} className={cn("flex min-w-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-left text-xs font-medium", scene?.id === item.id ? "border-primary/30 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent")}><span className="shrink-0">{index + 1}.</span><span className="truncate">{item.name}</span></button>)}</div>
        {scene && <div key={scene.id} className="min-w-0 space-y-4 rounded-xl border border-border bg-background/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold text-muted-foreground">Scene {sceneIndex + 1} of {selected.scenes.length}</span><div className="flex items-center gap-2">
            <button type="button" aria-label="Move scene earlier" className={button} disabled={locked || sceneIndex <= 0} onClick={() => patchEvent(e => ({ ...e, scenes: move(e.scenes, e.scenes.findIndex(s => s.id === scene.id), -1) }))}><ArrowUp size={14} /></button>
            <button type="button" aria-label="Move scene later" className={button} disabled={locked || sceneIndex === selected.scenes.length - 1} onClick={() => patchEvent(e => ({ ...e, scenes: move(e.scenes, e.scenes.findIndex(s => s.id === scene.id), 1) }))}><ArrowDown size={14} /></button>
            <TwoTapDeleteButton disabled={locked} onConfirm={() => patchEvent(e => ({ ...e, scenes: e.scenes.filter(s => s.id !== scene.id) }))} className="p-2 text-xs font-medium text-destructive" armedChildren="Confirm delete"><Trash2 size={14} className="mr-1 inline" />Delete scene</TwoTapDeleteButton>
          </div></div>
          <label className={label}>Scene name<DebouncedInput aria-label="Scene name" value={scene.name} maxLength={200} onCommit={name => patchScene(s => ({ ...s, name }))} className={field} /></label>
          <label className={label}>What should happen?<DebouncedTextarea aria-label="Scene instructions" maxLength={8000} value={scene.instructions} onCommit={instructions => patchScene(s => ({ ...s, instructions }))} className={`${field} min-h-28`} placeholder="Describe this scene and the NPCs involved. Leave the player's decisions to them." /></label>
          <p className="text-xs leading-relaxed text-muted-foreground">Only the current scene is sent to the model. Later scenes stay hidden until this one completes.</p>
          <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">Required moments</h5><button type="button" disabled={locked || scene.requiredMoments.length >= 16} onClick={() => patchScene(s => ({ ...s, requiredMoments: [...s.requiredMoments, { id: id("moment"), description: "" }] }))} className="text-xs font-medium text-primary disabled:opacity-40">+ Add required moment</button></div>
            <p className="text-xs leading-relaxed text-muted-foreground">Write a clear, observable occurrence for each moment. All must happen in the actual story; plans and mentions do not count. Confirmation can accumulate over several turns.</p>
            {scene.requiredMoments.map((moment, index) => <div className="flex min-w-0 items-start gap-2" key={moment.id}><label className="min-w-0 flex-1 text-xs text-muted-foreground">Moment {index + 1}<DebouncedTextarea aria-label={`Required moment ${index + 1}`} maxLength={2000} value={moment.description} onCommit={description => patchScene(s => ({ ...s, requiredMoments: s.requiredMoments.map(m => m.id === moment.id ? { ...m, description } : m) }))} className={`${field} mt-1 min-h-20`} /></label><button type="button" aria-label={`Remove required moment ${index + 1}`} className="mt-5 p-2 text-muted-foreground hover:text-destructive" onClick={() => patchScene(s => ({ ...s, requiredMoments: s.requiredMoments.filter(m => m.id !== moment.id) }))}><Trash2 size={15} /></button></div>)}
          </div>
          <ConditionEditor label="Additional completion conditions (all)" variables={world.variables} conditions={scene.completionConditions} onChange={completionConditions => patchScene(s => ({ ...s, completionConditions }))} />
          {!scene.requiredMoments.length && !scene.completionConditions.length && <p role="status" className="text-xs text-amber-400">Add a required moment or completion condition before enabling this event.</p>}
          <details className="min-w-0 border-t border-border pt-3"><summary className="cursor-pointer text-sm font-semibold">When this scene completes</summary><div className="mt-4"><ChapterEventEffectsEditor {...effectsProps} effects={scene.effects} entryChanges={scene.entryChanges} onChange={patch => patchScene(s => ({ ...s, ...patch }))} /></div></details>
        </div>}
      </div>
      <details className="min-w-0 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-semibold">When the whole event completes</summary><p className="my-3 text-xs leading-relaxed text-muted-foreground">Apply these lasting effects once, after the final scene. Completed events do not restart on reload.</p><ChapterEventEffectsEditor {...effectsProps} effects={selected.effects} entryChanges={selected.entryChanges} onChange={patch => patchEvent(e => ({ ...e, ...patch }))} /></details>
    </div>}
  </section>;
}
