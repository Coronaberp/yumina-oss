import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BookOpen, Search, Image, FilePenLine, Check, CircleAlert, CircleHelp, Loader2, ChevronDown, ListChecks, RotateCcw } from "lucide-react";
import type { StudioTraceItem } from "@yumina/shared";
import { ImageLightbox, type PreviewImage } from "@/components/image-lightbox";
import { resolveImageUrl } from "@/lib/asset-url";
import { useEditorStore } from "@/stores/editor";
import type { StudioChatMessage } from "../lib/types";
import { NameGenerationCard } from "./name-generation-card";

const icons = { read: BookOpen, search: Search, image: Image, write: FilePenLine, check: ListChecks, action: ListChecks };
const apiBase = import.meta.env.VITE_API_URL || "";
const elapsedSeconds = (startedAt: number, completedAt: number) => {
  const duration = completedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 ? Math.max(1, Math.round(duration / 1000)) : null;
};

export function AgentTrace({ trace, worldId, cards }: {
  trace: NonNullable<StudioChatMessage["activityTrace"]>;
  worldId: string | null;
  cards?: ReadonlyMap<string, ReactNode>;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [restoredDurationSeconds, setRestoredDurationSeconds] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const latest = trace.items.at(-1);
  const durationFromTrace = typeof trace.startedAt === "number" && typeof trace.completedAt === "number"
    ? elapsedSeconds(trace.startedAt, trace.completedAt) : null;
  const durationSeconds = durationFromTrace ?? restoredDurationSeconds;

  useEffect(() => {
    let active = true;
    setSnapshotId(null);
    setUndoError(null);
    setUndoMessage(null);
    if (!worldId || !trace.runId) return () => { active = false; };
    void fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/snapshots?agentRunId=${encodeURIComponent(trace.runId)}`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json().catch(() => null);
        return Array.isArray(body?.data) ? body.data[0] : null;
      })
      .then((snapshot) => { if (active && typeof snapshot?.id === "string") setSnapshotId(snapshot.id); })
      .catch(() => {});
    return () => { active = false; };
  }, [worldId, trace.runId, trace.items.length]);

  useEffect(() => {
    let active = true;
    setRestoredDurationSeconds(null);
    if (durationFromTrace !== null || !worldId || !trace.runId) return () => { active = false; };
    void fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/agent/status?runId=${encodeURIComponent(trace.runId)}`, { credentials: "include" })
      .then(async response => response.ok ? response.json().catch(() => null) : null)
      .then(body => {
        const run = body?.data;
        if (!run || !["completed", "error"].includes(run.status)) return null;
        const startedAt = typeof run.createdAt === "number" ? run.createdAt : Date.parse(run.createdAt);
        const completedAt = typeof run.updatedAt === "number" ? run.updatedAt : Date.parse(run.updatedAt);
        return elapsedSeconds(startedAt, completedAt);
      })
      .then(seconds => { if (active && typeof seconds === "number") setRestoredDurationSeconds(seconds); })
      .catch(() => {});
    return () => { active = false; };
  }, [worldId, trace.runId, durationFromTrace]);

  const undoRun = async () => {
    if (!worldId || !snapshotId || restoring) return;
    setRestoring(true);
    setUndoError(null);
    setUndoMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/rollback/${encodeURIComponent(snapshotId)}`, {
        method: "POST", credentials: "include",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Undo failed (HTTP ${response.status}).`);
      await useEditorStore.getState().refreshWorldSchema();
      setSnapshotId(null);
      setUndoMessage(body?.held
        ? "Restored in the working copy; the published version still needs review."
        : "Agent changes reverted. The previous state is saved in change history.");
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : "Could not undo this agent run.");
    } finally {
      setRestoring(false);
    }
  };

  if (!latest) return null;
  return <>
    <details className="group min-w-0 text-xs text-muted-foreground" data-agent-trace={trace.runId} onToggle={event => setTraceOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">Agent activity <span className="opacity-60">({trace.items.length})</span></span>
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <p className="mb-2 pl-5 text-[10px]">{trace.model === "codex/gpt-6-luna" ? "Codex account · GPT-6 Luna · Max" : trace.model.replace(/^(custom|openrouter)\//, "")}</p>
      {snapshotId && <button type="button" disabled={restoring} onClick={() => void undoRun()} className="mb-2 ml-5 inline-flex min-h-8 items-center gap-1.5 rounded border border-border px-2 text-[11px] text-foreground hover:bg-muted disabled:opacity-50">
        {restoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
        {restoring ? "Undoing…" : "Undo this run"}
      </button>}
      {undoError && <p className="mb-2 ml-5 break-words text-[11px] text-destructive" role="alert">{undoError}</p>}
      {undoMessage && <p className="mb-2 ml-5 break-words text-[11px] text-muted-foreground" role="status">{undoMessage}</p>}
      <ol className="max-h-80 space-y-1.5 overflow-y-auto overscroll-contain pl-5 pr-1">
        {trace.items.map(item => <TraceRow key={item.id} item={item} card={cards?.get(item.id)} onPreview={setPreview} />)}
      </ol>
    </details>
    {!traceOpen && durationSeconds !== null && <p className="mt-0.5 pl-5 text-[10px] text-muted-foreground" role="status">
      Contemplated for {durationSeconds} seconds
    </p>}
    <ImageLightbox image={preview} onClose={() => setPreview(null)} />
  </>;
}

function TraceRow({ item, card, onPreview }: { item: StudioTraceItem; card?: ReactNode; onPreview: (image: PreviewImage) => void }) {
  const Icon = icons[item.kind], Status = item.status === "working" ? Loader2 : item.status === "failed" ? CircleAlert : item.status === "unconfirmed" ? CircleHelp : Check;
  const label = <><span>{item.title}</span>{item.detail && <span className="ml-1 break-words text-muted-foreground/80">{item.detail}</span>}</>;
  const hasDetails = card !== undefined || item.generatedNames !== undefined;
  const row = <>
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{label}</span>
    <Status aria-label={item.status === "done" ? "Completed" : item.status === "failed" ? "Failed" : item.status === "unconfirmed" ? "Outcome unavailable" : "In progress"} className={`mt-0.5 h-3 w-3 shrink-0 ${item.status === "working" ? "animate-spin" : item.status === "failed" ? "text-destructive" : "opacity-60"}`} />
  </>;
  return <li className="min-w-0">
    {hasDetails ? <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-start gap-1.5 rounded py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {row}
        <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1.5 min-w-0 space-y-2 pl-5">
        {item.assetRef && <button type="button" className="inline-flex items-center gap-1 text-left text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Preview image ${item.detail}`} onClick={() => onPreview({ src: resolveImageUrl(item.assetRef)!, alt: item.detail })}>
          <Image className="h-3 w-3" aria-hidden="true" />Preview image
        </button>}
        {item.generatedNames !== undefined && <NameGenerationCard names={item.generatedNames} failed={item.status === "failed"} />}
        {card}
      </div>
    </details> : <div className="flex min-w-0 items-start gap-1.5">
      {item.assetRef ? <button type="button" className="flex min-w-0 flex-1 items-start gap-1.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Preview image ${item.detail}`} onClick={() => onPreview({ src: resolveImageUrl(item.assetRef)!, alt: item.detail })}>{row}</button>
        : row}
    </div>}
  </li>;
}
