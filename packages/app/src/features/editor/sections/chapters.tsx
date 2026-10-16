import { useId, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowUp, ArrowDown, BookOpen, Plus, Trash2 } from "lucide-react";
import { chapterSchema, chapterIssues, type StoryChapter } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChapterEventsEditor } from "../components/chapter-events-editor";

const input = "w-full min-w-0 rounded-xl border border-border bg-card px-4 py-3 text-sm font-normal text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50";
const label = "block space-y-3 text-sm font-bold text-foreground";
const secondaryButton = "flex items-center gap-1.5 rounded-lg border border-border bg-card p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";
const description = "Organize eras and alternate histories in one universe. Link the starting greetings and lore for each chapter.";

export function ChaptersSection({ compact = false }: { compact?: boolean } = {}) {
  const world = useEditorStore(s => s.worldDraft);
  const locked = useEditorStore(s => s.guestMode || s.readOnlyInspect);
  const chapters = world.chapters ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Studio shows the first available chapter, including chapters loaded after
  // mount or a surviving chapter after deletion. The full editor keeps its
  // explicit mobile list/back navigation.
  const selected = chapters.find(chapter => chapter.id === selectedId) ?? (compact ? chapters[0] : undefined);
  const selectedIndex = chapters.findIndex(chapter => chapter.id === selected?.id);
  const tabsId = useId();
  const issues = chapterIssues(world);
  const greetings = world.entries.filter(entry => entry.role === "greeting");
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];

  function patch(updates: Partial<StoryChapter>) {
    if (!selected) return;
    const current = useEditorStore.getState();
    if (current.guestMode || current.readOnlyInspect) return;
    current.setChapters((current.worldDraft.chapters ?? []).map(chapter => chapter.id === selected.id ? { ...chapter, ...updates } : chapter));
  }
  function add() {
    const current = useEditorStore.getState();
    if (current.guestMode || current.readOnlyInspect) return;
    const existing = current.worldDraft.chapters ?? [];
    const chapter = chapterSchema.parse({ id: `chapter-${crypto.randomUUID()}`, name: `Chapter ${existing.length + 1}` });
    current.setChapters([...existing, chapter]);
    setSelectedId(chapter.id);
  }
  function move(direction: number) {
    const current = useEditorStore.getState();
    if (current.guestMode || current.readOnlyInspect) return;
    const next = [...(current.worldDraft.chapters ?? [])];
    const index = next.findIndex(chapter => chapter.id === selected?.id), target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    current.setChapters(next);
  }
  function remove() {
    const current = useEditorStore.getState();
    if (current.guestMode || current.readOnlyInspect) return;
    current.setChapters((current.worldDraft.chapters ?? []).filter(chapter => chapter.id !== selected?.id));
    setSelectedId(null);
  }
  function toggleBook(bookId: string) {
    if (!selected) return;
    const current = useEditorStore.getState();
    if (current.guestMode || current.readOnlyInspect) return;
    current.setChapters(current.worldDraft.chapters ?? [], (current.worldDraft.worldbooks ?? []).map(book => book.id === bookId ? { ...book, chapterIds: toggle(book.chapterIds ?? [], selected.id) } : book));
  }
  function navigateTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % chapters.length;
    else if (event.key === "ArrowLeft") next = (index + chapters.length - 1) % chapters.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = chapters.length - 1;
    else return;
    event.preventDefault();
    setSelectedId(chapters[next]!.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  const addButton = (
    <button type="button" disabled={locked} onClick={add} className={cn("flex shrink-0 items-center gap-1.5 rounded-lg bg-primary font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50", compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm")}>
      <Plus className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />Add chapter
    </button>
  );
  const issueNotice = issues.length > 0 && (
    <div role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-400">
      {issues.map((issue, index) => <p key={index}>{issue}</p>)}
    </div>
  );
  const details = selected && (
    <div key={selected.id} role={compact ? "tabpanel" : undefined} id={`${tabsId}-details-${selected.id}`} aria-labelledby={compact ? `${tabsId}-tab-${selected.id}` : undefined} className="min-w-0 space-y-6">
      {!compact && <button type="button" onClick={() => setSelectedId(null)} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground @[640px]:hidden"><ArrowLeft size={16} />All chapters</button>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-foreground">Edit chapter</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="Move chapter earlier" disabled={locked || selectedIndex <= 0} onClick={() => move(-1)} className={secondaryButton}><ArrowUp size={15} /></button>
          <button type="button" aria-label="Move chapter later" disabled={locked || selectedIndex >= chapters.length - 1} onClick={() => move(1)} className={secondaryButton}><ArrowDown size={15} /></button>
          <TwoTapDeleteButton disabled={locked} onConfirm={remove} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50" armedChildren="Confirm delete"><Trash2 size={15} />Delete chapter</TwoTapDeleteButton>
        </div>
      </div>
      <fieldset disabled={locked} className="min-w-0 space-y-6 disabled:opacity-60">
        <label className={label}>Name<DebouncedInput aria-label="Chapter name" value={selected.name} onCommit={name => patch({ name })} className={input} /></label>
        <label className="flex items-center gap-2 text-sm font-medium"><Checkbox disabled={locked} checked={selected.enabled !== false} onCheckedChange={checked => patch({ enabled: checked === true })} />Enable this chapter</label>
        <div className="grid gap-4 @[640px]:grid-cols-2">
          <label className={label}>Timeline<DebouncedInput aria-label="Chapter timeline" placeholder="Main history" value={selected.timeline} onCommit={timeline => patch({ timeline })} className={input} /></label>
          <label className={label}>Date or era<DebouncedInput aria-label="Chapter date" placeholder="2280 · Academy era" value={selected.date} onCommit={date => patch({ date })} className={input} /></label>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Different dates can share a timeline. Use another timeline label for an alternate history; this label does not merge playthroughs.</p>
        <label className={label}>Chapter context<DebouncedTextarea aria-label="Chapter context" value={selected.description} onCommit={description => patch({ description })} className={`${input} min-h-28 font-normal leading-relaxed`} placeholder="What is true at this point in the story?" /></label>
        <section className="space-y-3">
          <h3 className="text-sm font-bold text-foreground">Starting greetings</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">These openings start in this chapter and keep their own starting values. Each greeting belongs to one enabled chapter.</p>
          {!greetings.length && <p className="text-sm text-muted-foreground">Add an opening under First Message, then link it here.</p>}
          {greetings.map(greeting => {
            const owner = chapters.find(chapter => chapter.id !== selected.id && chapter.enabled !== false && chapter.greetingIds.includes(greeting.id));
            return <label key={greeting.id} className="flex items-start gap-3 rounded-xl border border-border bg-card/50 p-3 text-sm font-medium transition-colors hover:bg-accent/50"><Checkbox className="mt-0.5" disabled={locked || !!owner} checked={selected.greetingIds.includes(greeting.id)} onCheckedChange={() => patch({ greetingIds: toggle(selected.greetingIds, greeting.id) })} /><span className="min-w-0 break-words">{greeting.name}{owner && <small className="mt-1 block text-xs font-normal text-muted-foreground">Linked to {owner.name}</small>}</span></label>;
          })}
        </section>
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><BookOpen size={16} />Chapter lorebooks</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">Link lore and character versions for this starting chapter. Linked books replace their opening gate. Unlinked Core lore stays shared. A disabled lorebook stays disabled.</p>
          {(world.worldbooks ?? []).map(book => <label key={book.id} className="flex items-start gap-3 rounded-xl border border-border bg-card/50 p-3 text-sm font-medium transition-colors hover:bg-accent/50"><Checkbox className="mt-0.5" disabled={locked} checked={book.chapterIds?.includes(selected.id) ?? false} onCheckedChange={() => toggleBook(book.id)} /><span className="min-w-0 break-words">{book.name}</span></label>)}
          {!world.worldbooks?.length && <p className="text-xs text-muted-foreground">Create a lorebook in Lorebook, then link it here.</p>}
        </section>
        <ChapterEventsEditor key={selected.id} chapterId={selected.id} />
      </fieldset>
    </div>
  );

  if (compact) return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden" data-chapters-editor>
      <div className="min-h-0 flex-1 overflow-y-auto" data-chapter-detail-scroll>
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-4">
        {chapters.length > 0 ? <>
          <div className="flex justify-end">{addButton}</div>
          <div className="space-y-2">
            <div role="tablist" aria-label="Chapters" className="flex flex-wrap gap-2">
              {chapters.map((chapter, index) => <button key={chapter.id} id={`${tabsId}-tab-${chapter.id}`} role="tab" type="button" aria-selected={selected?.id === chapter.id} aria-controls={`${tabsId}-details-${chapter.id}`} tabIndex={selected?.id === chapter.id ? 0 : -1} onClick={() => setSelectedId(chapter.id)} onKeyDown={event => navigateTab(event, index)} className={cn("max-w-full min-w-0 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors", selected?.id === chapter.id ? "bg-primary text-primary-foreground shadow-sm" : "border border-border bg-card text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground")}><span className="block break-words">{chapter.name}{chapter.enabled === false ? " · Disabled" : ""}</span></button>)}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
          {issueNotice}
          {details}
        </> : <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"><BookOpen className="h-6 w-6 text-primary" /></div>
          <h2 className="mb-2 text-lg font-bold text-foreground">No chapters yet</h2>
          <p className="mb-5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
          {addButton}
        </div>}
      </div>
      </div>
    </div>
  );

  return <div className="@container flex min-h-0 flex-1 flex-col" data-chapters-editor>
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-card px-6 py-4">
      <div><h1 className="text-[22px] font-bold tracking-tight text-foreground">Chapters</h1><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">{description}</p></div>
      {addButton}
    </header>
    {issueNotice && <div className="shrink-0 p-3">{issueNotice}</div>}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden @[640px]:flex-row">
      <aside aria-label="Chapters list" className={cn("min-h-0 overflow-y-auto border-border bg-sidebar p-5 @[640px]:w-80 @[640px]:shrink-0 @[640px]:border-r", selected && "hidden @[640px]:block")}>
        {!chapters.length && <p className="p-4 text-sm text-muted-foreground">No chapters yet. Add one, then link an existing greeting and its lorebooks.</p>}
        {chapters.map(chapter => <button key={chapter.id} type="button" aria-pressed={selected?.id === chapter.id} onClick={() => setSelectedId(chapter.id)} className="mb-2 block w-full rounded-xl border border-transparent p-4 text-left transition-colors hover:bg-accent aria-pressed:border-primary/30 aria-pressed:bg-primary/[0.06]"><span className="block text-sm font-bold">{chapter.name}</span><span className="mt-1 block text-xs text-muted-foreground">{[chapter.timeline, chapter.date].filter(Boolean).join(" · ") || "Same universe"}{chapter.enabled === false ? " · Disabled" : ""}</span></button>)}
      </aside>
      <div data-chapter-detail-scroll className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto p-6 @[640px]:p-8", !selected && "hidden @[640px]:block")}>
        <div className="mx-auto max-w-3xl">{details || <p className="p-8 text-center text-sm text-muted-foreground">Select a chapter to manage its starting greetings and lore.</p>}</div>
      </div>
    </div>
  </div>;
}
