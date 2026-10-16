import { useEffect, useId, useState } from "react";
import { GitBranch } from "lucide-react";
import { useChatStore } from "@/stores/chat";
import { useUiStore } from "@/stores/ui";
import { canSelectStoryOpening } from "@/lib/can-select-story-opening";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

type Props = {
  showTrigger?: boolean;
  greetings: { id: string; name: string }[];
  chapters: { id: string; name: string; timeline: string; date: string; greetingIds: string[]; enabled?: boolean }[];
};

/** Chapters group starting greetings. Both tabs select an existing opening;
 * neither appends a turn, resets an ongoing save, or offers in-play navigation. */
export function StoryNavigation({ chapters, showTrigger = true, greetings }: Props) {
  const session = useChatStore(s => s.session);
  const messages = useChatStore(s => s.messages);
  const isStreaming = useChatStore(s => s.isStreaming);
  const hasEarlierMessages = useChatStore(s => s.hasEarlierMessages);
  const readOnly = useChatStore(s => s.readOnly);
  const open = useUiStore(s => s.storyRoutesOpen);
  const close = useUiStore(s => s.closeStoryRoutes);
  const available = canSelectStoryOpening({ session, messages, isStreaming, hasEarlierMessages, readOnly });
  const opening = messages.find(message => message.role !== "system");
  const routes = (opening?.swipes ?? []).map((swipe, index) => {
    const savedId = swipe.stateSnapshot?.activeGreetingId;
    const greeting = typeof savedId === "string" ? greetings.find(greeting => greeting.id === savedId) : greetings[index];
    return { index, id: greeting?.id, name: greeting?.name || `Route ${index + 1}` };
  });
  const groups = chapters.filter(chapter => chapter.enabled !== false).map(chapter => ({
    ...chapter, routes: routes.filter(route => route.id && chapter.greetingIds.includes(route.id)),
  })).filter(chapter => chapter.routes.length);
  const [tab, setTab] = useState<"routes" | "chapters">("routes");
  const tabId = useId();
  const activeTab = groups.length ? tab : "routes";
  useEffect(() => { if (!available) close(); }, [available, close]);
  useEffect(() => () => close(), [session?.id, close]);
  function select(index: number) {
    if (!canSelectStoryOpening(useChatStore.getState())) return;
    useChatStore.getState().switchGreeting(index);
    close();
  }
  if (!available) return null;
  const routeButton = (route: typeof routes[number]) => <button key={route.index} type="button" aria-pressed={route.index === (opening?.activeSwipeIndex ?? 0)} onClick={() => select(route.index)} className="block w-full rounded-xl border border-border p-4 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/10">{route.name}</button>;
  return <>
    {showTrigger && <button type="button" aria-label="Open routes" title="Routes" onClick={() => useUiStore.getState().openStoryRoutes()} className="absolute right-3 top-24 z-40 flex items-center gap-2 rounded-xl border border-border bg-background/90 px-3 py-2 text-sm text-foreground shadow-lg"><GitBranch size={16} />Routes</button>}
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Routes</DialogTitle><DialogDescription>Choose where this playthrough starts. Routes and chapters can only be changed while you are still at the greeting.</DialogDescription></DialogHeader>
        <div role="tablist" aria-label="Story navigation" className="flex gap-2 border-b border-border pb-3">
          {(["routes", ...(groups.length ? ["chapters"] : [])] as const).map(value => <button key={value} type="button" role="tab" id={`${tabId}-${value}`} aria-selected={activeTab === value} aria-controls={`${tabId}-panel`} onClick={() => setTab(value as "routes" | "chapters")} className="rounded-lg border border-border px-4 py-2 text-sm aria-selected:border-primary aria-selected:bg-primary/10 aria-selected:text-primary">{value === "routes" ? "Routes" : "Chapters"}</button>)}
        </div>
        <section role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${activeTab}`} className="space-y-3">
          {activeTab === "routes" ? routes.map(routeButton) : groups.map(chapter => <section key={chapter.id} className="space-y-3 rounded-xl border border-border p-4">
            <div><h2 className="font-semibold">{chapter.name}</h2><p className="text-sm text-muted-foreground">{[chapter.timeline, chapter.date].filter(Boolean).join(" · ")}</p></div>
            {chapter.routes.map(routeButton)}
          </section>)}
        </section>
      </DialogContent>
    </Dialog>
  </>;
}
