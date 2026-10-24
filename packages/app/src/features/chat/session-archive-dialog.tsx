import { useEffect, useRef, useState } from "react";
import { Download, FileUp, Loader2 } from "lucide-react";
import type { ArchiveMode } from "@yumina/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadSessionArchive, importArchive } from "./archive-client";
import { parseArchiveUpload, type ArchiveUpload } from "./archive-upload";
import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { useWorldsStore } from "@/stores/worlds";

const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#b69a6966] bg-[#ccaa671c] px-4 py-2 text-sm text-[#ecd8a6] disabled:opacity-50";
export function SessionArchiveDialog({ open, onClose, sessionId }: { open: boolean; onClose: () => void; sessionId?: string }) {
  const [mode, setMode] = useState<ArchiveMode>("transcript");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<ArchiveUpload | null>(null);
  const preview = upload?.preview;
  const file = useRef<HTMLInputElement>(null);
  const navigateToStory = useStoryNavigation();
  const requestVersion = useRef(0);
  const inFlight = useRef<number | null>(null);
  useEffect(() => { requestVersion.current++; inFlight.current = null; setError(null); setProgress(""); setUpload(null); setBusy(false); return () => { requestVersion.current++; }; }, [open, sessionId]);
  const run = async (work: (active: () => boolean) => Promise<void>) => {
    if (inFlight.current !== null) return;
    const version = requestVersion.current;
    inFlight.current = version;
    setBusy(true); setError(null);
    try { await work(() => version === requestVersion.current); }
    catch (cause) { if (version === requestVersion.current) { setProgress(""); setError(cause instanceof Error ? cause.message : "The archive could not be saved. Try again."); } }
    finally { if (inFlight.current === version) inFlight.current = null; if (version === requestVersion.current) setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto border-[#b69a6966] bg-[#261f18] text-[#e8dfcd]" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Export and import chat</DialogTitle><DialogDescription className="text-[#bfb097]">Save a readable HTML transcript, or restore a previous export.</DialogDescription></DialogHeader>
      {sessionId && <section className="space-y-3" aria-label="Export chat">
        <div className="grid grid-cols-2 gap-3" role="group" aria-label="Export contents">
          {(["transcript", "full-save"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => setMode(value)} className={`min-h-20 rounded-lg border p-3 text-left ${mode === value ? "border-[#c8b17e] bg-[#ccaa671c]" : "border-[#b69a6933]"}`}>
            <span className="block text-sm font-semibold">{value === "transcript" ? "Transcript" : "Full save"}</span><span className="mt-1 block text-xs text-[#bfb097]">{value === "transcript" ? "Messages, portraits and attachments" : "World, progress, checkpoints and memory"}</span>
          </button>)}
        </div>
        <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={() => void run(async active => { await downloadSessionArchive(sessionId, mode, text => { if (active()) setProgress(text); }); if (active()) setProgress("HTML downloaded. Open it in a browser to read, search and filter your chat."); })}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download HTML</button>
      </section>}
      <section className="space-y-3 border-t border-[#b69a6933] pt-4" aria-label="Import chat">
        <input ref={file} type="file" accept=".html,.htm,.json,text/html,application/json" className="sr-only" aria-label="Choose chat archive" disabled={busy} onChange={event => {
          const selected = event.target.files?.[0]; event.target.value = ""; if (!selected) return;
          void run(async active => { setUpload(null); setProgress("Reading the saved archive…"); const parsed = await parseArchiveUpload(selected); if (active()) { setUpload(parsed); setProgress(""); } });
        }} />
        <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={() => file.current?.click()}><FileUp className="h-4 w-4" />Choose HTML or JSON to import</button>
        {preview && <div className="space-y-3 rounded-lg border border-[#b69a694d] p-3">
          <p className="break-words text-sm font-semibold">{preview.sessionName || preview.worldName}</p><p className="text-xs text-[#bfb097]">{preview.worldName} · {preview.messageCount} messages · {preview.mode === "full-save" ? "Full save" : "Transcript"}</p>
          <p className="text-xs text-[#bfb097]">{preview.mode === "full-save" ? "Creates a new card and session with the saved progress and embedded images." : "Creates a new session on the original card and reuses its images. Progress starts from the card's defaults."}</p>
          <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={() => void run(async active => { if (!upload) return; setProgress("Restoring the saved chat…"); const result = await importArchive(upload.payload, { requestId: upload.requestId, contextSessionId: sessionId, onProgress: text => { if (active()) setProgress(text); } }); if (active()) { void useWorldsStore.getState().fetchWorlds(); onClose(); navigateToStory(result.sessionId); } })}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Import as a new session</button>
        </div>}
      </section>
      {progress && <p className="text-sm text-[#bfb097]" role="status" aria-live="polite">{progress}</p>}
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
    </DialogContent>
  </Dialog>;
}
