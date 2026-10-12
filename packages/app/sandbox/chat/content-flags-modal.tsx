import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ContentFlagInspection } from "@yumina/shared";
import { CONTENT_FLAG_POLICY_ID, CONTENT_FLAG_THRESHOLD, CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY, conservativeRoutingSafe, isCompleteContentFlag } from "@yumina/shared";
import { useYumina } from "../sandbox-context";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";
import { focusGuardDialog, installGuardFocusScope } from "../extensions/state-update-guard/focus";

/** Owner-only inspector. It never changes game variables or model selection. */
export function ContentFlagsModal({ onClose }: { onClose: () => void }) {
  const api = useYumina();
  const [data, setData] = useState<ContentFlagInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try { const result = await api.getContentFlags(); if (alive.current) { setData(result); setError(null); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Could not load content flags"); }
  }, [api.getContentFlags]);
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const cleanup = installGuardFocusScope(el.ownerDocument, () => el, onClose);
    focusGuardDialog(el); return cleanup;
  }, [onClose]);
  const retry = async (id: string) => {
    setBusy(id);
    try { await api.retryContentFlag(id); await refresh(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Could not classify this message"); }
    finally { if (alive.current) setBusy(null); }
  };
  const turnFlags = data && [data.turn.inputMessageId, data.turn.outputMessageId].map(id => data.messages.find(row => row.id === id)?.contentFlags);
  const turnComplete = turnFlags?.length === 2 && turnFlags.every(isCompleteContentFlag);
  const turnNsfw = turnFlags?.some(flag => isCompleteContentFlag(flag) && flag.label === "nsfw");
  const turnRoutingSafe = turnComplete && turnFlags.every(conservativeRoutingSafe);
  return <SandboxPlatformOverlay>
    <div data-vn-dialog-backdrop="" className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onClick={onClose}>
      <div data-vn-dialog-surface="structured" ref={dialog} role="dialog" aria-modal="true" aria-label="Content flags" tabIndex={-1} onClick={e => e.stopPropagation()} className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 data-vn-dialog-title="" className="flex items-center gap-2 text-lg font-medium"><ShieldCheck size={20} />Content flags</h2>
          <button type="button" data-vn-dialog-close="" aria-label="Close content flags" onClick={onClose} className="rounded-lg p-2 hover:bg-muted"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto p-4">
          <p className="text-sm text-muted-foreground">Kev checks complete messages on CPU. Content is labeled NSFW at {CONTENT_FLAG_THRESHOLD * 100}% or above. Story requires at least {CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY * 100}% SFW confidence to use the SFW provider. Uncertain checks and explicit content use NSFW; sending is blocked if that connection is unavailable.</p>
          {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
          {data ? <>
            <div className="my-4 rounded-xl border border-border p-3 text-sm">Current turn: <strong>{turnNsfw ? "NSFW" : turnComplete ? "SFW" : "Not checked"}</strong>{turnComplete && !turnNsfw && !turnRoutingSafe && <span> · Requires NSFW routing</span>}</div>
            <div className="flex flex-col gap-3">
              {[...data.messages].reverse().map(row => {
                const flag = row.contentFlags;
                const stale = !!flag && flag.policyId !== CONTENT_FLAG_POLICY_ID;
                const complete = isCompleteContentFlag(flag);
                const pending = !stale && flag?.status === "pending";
                const statusLabel = stale ? "Not checked" : pending ? "Checking" : flag?.status === "error" ? "Check failed" : complete ? flag.label.toUpperCase() : "Not checked";
                const sfwPercent = complete ? (flag.sfwProbability * 100).toFixed(1) : null;
                const sfwDisplay = complete && flag.sfwProbability < CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY && Number(sfwPercent) >= CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY * 100
                  ? `<${CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY * 100}` : sfwPercent;
                const nsfwPercent = complete ? (flag.nsfwProbability * 100).toFixed(1) : null;
                const nsfwDisplay = complete && flag.nsfwProbability < CONTENT_FLAG_THRESHOLD && Number(nsfwPercent) >= CONTENT_FLAG_THRESHOLD * 100
                  ? `<${CONTENT_FLAG_THRESHOLD * 100}` : nsfwPercent;
                const probability = complete ? `${nsfwDisplay}% NSFW · ${sfwDisplay}% SFW` : null;
                return <div key={row.id} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <strong>{row.role === "user" ? "Player input" : "Response"}{row.role === "assistant" ? ` · Variant ${row.activeSwipeIndex + 1}` : ""}</strong>
                    <span>{statusLabel}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <div className="min-w-0">
                      <span>{stale ? "Needs a whole-message check" : statusLabel}{probability ? ` · ${probability}` : ""}{flag?.errorCode ? ` · ${flag.errorCode}` : ""}</span>
                      {complete && <p className="mt-1">{conservativeRoutingSafe(flag) ? "Eligible for SFW routing" : "Requires NSFW routing"}</p>}
                    </div>
                    <button type="button" disabled={busy !== null || pending || (row.role === "assistant" && row.status !== "complete")} onClick={() => void retry(row.id)} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 disabled:opacity-50 hover:bg-muted">
                      {pending || busy === row.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}{pending ? "Checking" : "Check again"}
                    </button>
                  </div>
                </div>;
              })}
              {!data.messages.length && <p className="text-sm text-muted-foreground">No messages yet.</p>}
            </div>
          </> : !error && <p role="status" className="flex items-center gap-2 py-6 text-sm"><Loader2 size={16} className="animate-spin" />Loading flags…</p>}
        </div>
      </div>
    </div>
  </SandboxPlatformOverlay>;
}
