import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2, WandSparkles } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";
import { statusDesignPrompt } from "../lib/status-builder";

export function StatusDesignAssistant({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const working = useStudioStore(state => state.isAgentWorking || !!state._pendingApproval || !!state.creditPause || !!state.pendingVisualizationTask);
  async function send() {
    if (disabled || launching || working || !request.trim()) return;
    setLaunching(true); setError("");
    try {
      const editor = useEditorStore.getState();
      if (editor.isDirty || !editor.serverWorldId) {
        if (!await editor.saveDraft()) throw new Error("Save your card successfully before asking the agent. Your request is kept here.");
      }
      const worldId = useEditorStore.getState().serverWorldId;
      if (!worldId || (editor.serverWorldId && worldId !== editor.serverWorldId)) return;
      const studio = useStudioStore.getState();
      if (studio.isAgentWorking || studio._pendingApproval || studio.creditPause) throw new Error("Finish the current agent task first, then try again.");
      useStudioStore.setState({ pendingVisualizationTask: { worldId, prompt: statusDesignPrompt(request) } });
      await router.navigate({ to: "/app/studio/$worldId", params: { worldId } });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not open the agent. Try again."); }
    finally { setLaunching(false); }
  }
  return <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
    <h3 className="flex items-center gap-2 text-sm font-medium"><WandSparkles size={16} className="text-primary" />Want a custom design?</h3>
    <p className="text-xs leading-relaxed text-muted-foreground">Describe it and the agent will build it. You can keep using these controls afterward.</p>
    <textarea aria-label="Describe your status design" placeholder="For example: show relationships as a compass, with health and mana underneath." value={request} onChange={event => setRequest(event.target.value)} rows={3} disabled={disabled || launching} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs focus:border-primary focus:outline-none" />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={disabled || launching || working || !request.trim()} onClick={() => void send()} className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground disabled:opacity-40">{launching ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}Ask agent</button><span className="text-[11px] text-muted-foreground">{working ? "Finish the current agent task first." : "Opens the Studio assistant to build your design."}</span></div>
  </section>;
}
