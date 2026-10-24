import { useEffect, useState } from "react";
import type { RequestReceipt } from "@yumina/shared";

interface Props { apiBase: string; sessionId: string; messageId: string; swipeIndex: number; version: string }
type Result = { available: boolean; receipts?: RequestReceipt[] };
type LoadState = { key: string; status: "loading" | "error" | "denied" | "loaded"; data?: Result };
const counter = (value: number | undefined) => value === undefined ? "Unknown" : value.toLocaleString();

export default function RequestInspectionPanel({ apiBase, sessionId, messageId, swipeIndex, version }: Props) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LoadState>();
  const [generation, setGeneration] = useState("");
  const [attemptIndex, setAttemptIndex] = useState(-1);
  const key = `${sessionId}:${messageId}:${swipeIndex}:${version}:${retry}`;
  useEffect(() => {
    const abort = new AbortController();
    setState({ key, status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/request-inspection?swipe=${swipeIndex}`, { credentials: "include", cache: "no-store", signal: abort.signal });
        if (abort.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) { setState({ key, status: "denied" }); return; }
        if (!response.ok) throw new Error("Request unavailable");
        const body = await response.json() as { data: Result };
        if (!abort.signal.aborted) { setGeneration(""); setAttemptIndex(-1); setState({ key, status: "loaded", data: body.data }); }
      } catch {
        if (!abort.signal.aborted) setState({ key, status: "error" });
      }
    })();
    return () => abort.abort();
  }, [key, apiBase, sessionId, messageId, swipeIndex]);

  if (!state || state.key !== key || state.status === "loading") return <p role="status" className="py-6 text-sm text-muted-foreground">Loading request…</p>;
  if (state.status === "denied") return <p role="status" className="py-6 text-sm text-muted-foreground">Request inspection is unavailable for this session.</p>;
  if (state.status === "error") return <div role="alert" className="space-y-3 py-4 text-sm text-muted-foreground"><p>Could not load this request.</p><button type="button" className="rounded-md border border-border px-3 py-2 text-foreground hover:bg-muted" onClick={() => setRetry(value => value + 1)}>Retry</button></div>;
  const receipts = state.data?.receipts ?? [];
  const receipt = receipts.find(item => item.id === generation) ?? receipts.at(-1);
  if (!state.data?.available || !receipt) return <div className="space-y-2 py-4 text-sm text-muted-foreground"><p>No retained request for this generation.</p><p className="text-xs">Older generations, expired receipts, server restarts, unsupported connections, or requests handled by another server may be unavailable. Requests are never reconstructed.</p></div>;
  const selectedAttempt = attemptIndex < 0 ? receipt.attempts.length - 1 : attemptIndex;
  const attempt = receipt.attempts[selectedAttempt];
  return <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm" data-request-inspection="">
    <p className="text-xs text-muted-foreground">Captured at final provider dispatch. Redacted, bounded receipts are retained in this server process for up to 30 minutes, subject to eviction. URLs and image data are omitted.</p>
    <div className="flex flex-wrap gap-3">
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">Generation
        <select aria-label="Generation" className="mt-1 block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-foreground" value={receipt.id} onChange={event => { setGeneration(event.target.value); setAttemptIndex(-1); }}>
          {receipts.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.kind} · {new Date(item.capturedAt).toLocaleString()}</option>)}
        </select>
      </label>
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">Dispatch attempt
        <select aria-label="Dispatch attempt" className="mt-1 block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-foreground" value={selectedAttempt} onChange={event => setAttemptIndex(Number(event.target.value))}>
          {receipt.attempts.map((item, index) => <option key={index} value={index}>{index + 1}. {item.provider} · {item.model}</option>)}
        </select>
      </label>
    </div>
    {receipt.omittedAttempts > 0 && <p className="text-xs text-muted-foreground">{receipt.omittedAttempts} earlier dispatch attempts omitted by the retention limit.</p>}
    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
      <p className="font-medium text-foreground">Provider-reported counters for this generation’s final attempt</p>
      <p className="mt-1">Input: {counter(receipt.usage?.promptTokens)} · Output: {counter(receipt.usage?.completionTokens)} · Total: {counter(receipt.usage?.totalTokens)}</p>
      {(receipt.usage?.reasoningTokens !== undefined || receipt.usage?.cacheReadTokens !== undefined || receipt.usage?.cacheWriteTokens !== undefined) && <p>Reasoning: {counter(receipt.usage.reasoningTokens)} · Cache read: {counter(receipt.usage.cacheReadTokens)} · Cache write: {counter(receipt.usage.cacheWriteTokens)}</p>}
      <p className="mt-1 text-muted-foreground">Provider definitions vary; cached or reasoning tokens may be separate. Missing counters stay unknown. These counts exclude earlier retries.</p>
    </div>
    {attempt && <>
      <p className="break-words text-xs"><span className="font-medium">{attempt.provider}</span> · {attempt.model}</p>
      <p className="text-xs text-muted-foreground">Text estimate: ≈{attempt.estimatedTextTokens.toLocaleString()} tokens (characters ÷ 4; {attempt.truncated ? "partial input only" : "text only"}). Excludes image tokens and protocol overhead; this is not an actual token count.</p>
      {attempt.truncated && <p className="text-xs text-amber-500">Truncated to the inspection size limit. Some request content is omitted.</p>}
      <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-xs font-medium">Sent parameters</summary><pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] [overflow-wrap:anywhere]">{JSON.stringify(attempt.parameters, null, 2)}</pre><p className="mt-2 text-xs text-muted-foreground">Only allowlisted provider parameters are shown. Other provider fields may be omitted.</p></details>
      <p className="text-xs font-medium">Sent prompt sections in wire order</p>
      {attempt.sections.map((section, index) => <details key={`${selectedAttempt}:${index}`} className="rounded-md border border-border bg-muted/30 p-3" open={attempt.sections.length === 1}>
        <summary className="cursor-pointer break-words text-xs font-medium">{section.name}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">{section.text}</pre>
      </details>)}
    </>}
  </div>;
}
