import { useState } from "react";
import { Brain } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { SessionMemoryModal } from "../extensions/session-memory/session-memory-modal";

/** Built-in entry point independent of the legacy summary extension. */
export function StoryMemoryLauncher() {
  const api = useYumina();
  const [open, setOpen] = useState(false);
  if (!api.sessionId) return null;
  const label = api.language?.startsWith("zh") ? "故事记忆" : "Story memory";
  return (
    <>
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-white/65 hover:bg-white/10"
      >
        <Brain className="h-3 w-3 shrink-0" />
        <span>{label}</span>
      </button>
      {open && (
        <SessionMemoryModal
          key={api.sessionId}
          open
          onClose={() => setOpen(false)}
          initialTab="storyhaven"
        />
      )}
    </>
  );
}
