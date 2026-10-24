import { lazy, Suspense, useEffect, useMemo, useState } from "react";

const RequestInspectionPanel = lazy(() => import("./request-inspection-panel"));
interface DebugMessage {
  id: string;
  role: string;
  content: string;
  activeSwipeIndex?: number;
  swipes?: Array<{ content: string; rawContent?: string; createdAt?: string; tokenCount?: number }>;
}
interface Props { messages: DebugMessage[]; sessionId: string; eligible: boolean; apiBase: string }

/** Lives only inside the shell debug dialog. Never forwarded into a card iframe. */
export function GenerationDebugContent({ messages, sessionId, eligible, apiBase }: Props) {
  const replies = useMemo(() => messages.filter(message => message.role === "assistant"), [messages]);
  const [messageId, setMessageId] = useState(() => replies.at(-1)?.id ?? "");
  const selected = replies.find(message => message.id === messageId) ?? replies.at(-1);
  const [swipeIndex, setSwipeIndex] = useState(() => selected?.activeSwipeIndex ?? 0);
  const [tab, setTab] = useState<"raw" | "request">("raw");
  const [allowed, setAllowed] = useState(false);
  const [accessStatus, setAccessStatus] = useState<"checking" | "ready" | "error">("checking");
  const [accessRetry, setAccessRetry] = useState(0);
  useEffect(() => {
    setAllowed(false); setTab("raw");
    if (!eligible) return;
    setAccessStatus("checking");
    const abort = new AbortController();
    void fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/request-inspection-access`, { credentials: "include", cache: "no-store", signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Permission unavailable");
        return await response.json() as { data?: { allowed?: boolean } };
      })
      .then(body => { if (!abort.signal.aborted) { setAllowed(body?.data?.allowed === true); setAccessStatus("ready"); } })
      .catch(() => { if (!abort.signal.aborted) setAccessStatus("error"); });
    return () => abort.abort();
  }, [sessionId, eligible, apiBase, accessRetry]);
  const swipe = selected?.swipes?.[swipeIndex];
  const raw = swipe?.rawContent;
  return <>
    {replies.length > 0 && <div className="flex flex-wrap gap-3">
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">Reply
        <select aria-label="Reply" className="mt-1 block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={selected?.id ?? ""} onChange={event => { setMessageId(event.target.value); setSwipeIndex(replies.find(message => message.id === event.target.value)?.activeSwipeIndex ?? 0); }}>
          {replies.map((message, index) => <option key={message.id} value={message.id}>Reply {index + 1}</option>)}
        </select>
      </label>
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">Swipe
        <select aria-label="Swipe" className="mt-1 block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={swipeIndex} onChange={event => setSwipeIndex(Number(event.target.value))}>
          {Array.from({ length: Math.max(1, selected?.swipes?.length ?? 0) }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
        </select>
      </label>
    </div>}
    <div className="flex flex-wrap gap-2 border-b border-border pb-2" role="group" aria-label="Generation inspection">
      <button type="button" aria-pressed={tab === "raw"} className={`rounded-md px-3 py-2 text-xs ${tab === "raw" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`} onClick={() => setTab("raw")}>Raw reply</button>
      {allowed && eligible && <button type="button" aria-pressed={tab === "request"} className={`rounded-md px-3 py-2 text-xs ${tab === "request" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`} onClick={() => setTab("request")}>Actual request</button>}
    </div>
    {eligible && accessStatus === "checking" && <p role="status" className="text-xs text-muted-foreground">Checking request inspection access…</p>}
    {eligible && accessStatus === "error" && <p className="text-xs text-muted-foreground">Could not check request inspection access. <button type="button" className="underline" onClick={() => setAccessRetry(value => value + 1)}>Retry access</button></p>}
    {tab === "request" && allowed && eligible && selected ? <Suspense fallback={<p role="status" className="py-6 text-sm text-muted-foreground">Loading request…</p>}>
      <RequestInspectionPanel key={`${sessionId}:${selected.id}:${swipeIndex}`} apiBase={apiBase} sessionId={sessionId} messageId={selected.id} swipeIndex={swipeIndex} version={`${swipe?.createdAt ?? ""}:${raw?.length ?? 0}:${swipe?.tokenCount ?? 0}`} />
    </Suspense> : raw ? <>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{raw}</div>
      {raw === (swipe?.content ?? selected?.content) && <p className="text-xs text-muted-foreground">Raw output matches the rendered reply.</p>}
    </> : <p className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">This reply has no saved raw output. Older replies cannot be reconstructed.</p>}
  </>;
}
