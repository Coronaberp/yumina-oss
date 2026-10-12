import { useState } from "react";
import { useChatStore } from "@/stores/chat";

/** Host-owned terminal surface. It sits above every sandbox root, including
 * custom/VN roots, so a card cannot hide completion state or re-enable input. */
export function StoryEndingStatus({ overlay = false }: { overlay?: boolean }) {
  const progress = useChatStore(s => s.storyProgress);
  const busy = useChatStore(s => s.isCompletingEnding);
  const error = useChatStore(s => s.endingError);
  const retry = useChatStore(s => s.retryEnding);
  const [retrying, setRetrying] = useState(false);
  if (progress.status === "playing") return null;
  const completed = progress.status === "completed";
  const runRetry = async () => {
    if (retrying || busy) return;
    setRetrying(true);
    try { await retry(); } catch { /* The store exposes the error beside Retry. */ } finally { setRetrying(false); }
  };
  return <div className={overlay
    ? "pointer-events-none absolute inset-x-0 top-24 z-50 flex justify-center px-4"
    : "relative z-50 flex shrink-0 justify-center px-4 py-3"} data-story-ending-status role="status" aria-live="polite">
    <div className="pointer-events-auto max-w-md rounded-2xl border border-border bg-background/95 px-4 py-3 text-center shadow-xl">
      <h2 className="text-lg font-semibold">{completed ? (progress.ending?.name ?? "The End") : busy || retrying ? "Completing ending…" : error ? "Ending needs a retry" : "Ending ready"}</h2>
      {!completed && !busy && error && <p className="mt-1 text-sm text-destructive">{error}</p>}
      {!completed && !busy && <button type="button" onClick={() => void runRetry()} disabled={retrying} className="mt-2 rounded-xl border border-border px-4 py-2 text-sm">{retrying ? "Retrying…" : error ? "Retry ending" : "Complete ending"}</button>}
      {!completed && busy && <p className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />Please wait…</p>}
    </div>
  </div>;
}
