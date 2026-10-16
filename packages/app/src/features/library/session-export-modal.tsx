import { useEffect, useState } from "react";
import { Clock, Download, FileUp, Loader2, MessageCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SessionArchiveDialog } from "@/features/chat/session-archive-dialog";

const apiBase = import.meta.env.VITE_API_URL || "";
interface SessionSummary { id: string; name: string | null; createdAt: string; messageCount: number; lastMessagePreview: string | null }
interface SessionExportModalProps { worldId: string; worldName: string; languageGroupId?: string | null; open: boolean; onClose: () => void }

/** Library and VN exports share the same archive format and import preview. */
export function SessionExportModal({ worldId, worldName, languageGroupId, open, onClose }: SessionExportModalProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (!open) setSelected(undefined); }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    const query = languageGroupId ? `languageGroupId=${encodeURIComponent(languageGroupId)}` : `worldId=${encodeURIComponent(worldId)}`;
    fetch(`${apiBase}/api/sessions?${query}`, { credentials: "include", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Could not load saved chats"); return response.json(); })
      .then(body => { if (!controller.signal.aborted) setSessions(Array.isArray(body.data) ? body.data : []); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, worldId, languageGroupId, retry]);
  if (selected !== undefined) return <SessionArchiveDialog open={open} onClose={onClose} sessionId={selected || undefined} />;
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto border-white/10 bg-[#1F1D21] text-[#FFF5D6]">
      <DialogHeader><DialogTitle>Export and import chat</DialogTitle><DialogDescription className="text-[#D1CEC6]/75">Choose a saved chat from {worldName} to download as HTML.</DialogDescription></DialogHeader>
      <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#C9A25E]/30 p-3 text-sm text-[#E0C27A]" onClick={() => setSelected(null)}><FileUp className="h-4 w-4" />Import HTML or JSON</button>
      <div className="space-y-2">
        {loading ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div> : error ? <div role="alert" className="space-y-3 p-4 text-sm"><p>Saved chats could not be loaded.</p><button type="button" className="min-h-11 underline" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : sessions.length === 0 ? <p className="py-8 text-center text-sm text-[#D1CEC6]/60">No saved chats for this card yet.</p> : sessions.map(session => <button key={session.id} type="button" onClick={() => setSelected(session.id)} className="flex min-h-16 w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left hover:border-[#C9A25E]/30">
          <Download className="mt-1 h-5 w-5 shrink-0 text-[#C9A25E]" /><div className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{session.name || `Chat from ${new Date(session.createdAt).toLocaleDateString()}`}</span><div className="mt-2 flex flex-wrap gap-3 text-xs text-[#D1CEC6]/60"><span className="inline-flex items-center gap-1"><MessageCircle className="h-3 w-3" />{session.messageCount} messages</span><span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(session.createdAt).toLocaleDateString()}</span></div>{session.lastMessagePreview && <p className="mt-2 line-clamp-2 text-xs text-[#D1CEC6]/65">{session.lastMessagePreview}</p>}</div>
        </button>)}
      </div>
    </DialogContent>
  </Dialog>;
}
