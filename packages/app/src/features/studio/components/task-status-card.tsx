import type { StudioTask } from "@yumina/shared";
import { Check, Circle, Loader2, Play } from "lucide-react";

const labels: Record<StudioTask["status"], string> = {
  working: "Working", waiting: "Waiting", completed: "Complete", needs_input: "Needs your answer",
  stalled: "Paused: no progress", budget_paused: "Step limit reached", stopped: "Stopped", interrupted: "Interrupted",
};
export function TaskStatusCard({ task, working, onContinue, allowContinue = true }: { task: StudioTask; working: boolean; allowContinue?: boolean; onContinue: () => void }) {
  if (task.mode === "answer" && !task.requirements.length) return null;
  const passed = task.requirements.filter(item => item.verified).length;
  const resumable = allowContinue && !working && ["stalled", "budget_paused", "interrupted", "stopped"].includes(task.status);
  return <section aria-label="Task progress" data-studio-task={task.status} className="my-3 min-w-0 rounded-xl border border-border bg-muted/20 p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      {working ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : task.status === "completed" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
      <span className="font-medium">{labels[task.status]}</span>
      <span className="text-muted-foreground">{task.requirements.length ? `${passed}/${task.requirements.length} checked` : "Checklist pending"} · {task.steps} steps</span>
      {resumable && <button type="button" onClick={onContinue} className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 text-primary hover:bg-primary/20 [@media(pointer:coarse)]:min-h-11"><Play className="h-3 w-3" />Continue task</button>}
    </div>
    {task.reason && <p className="mt-2 break-words text-muted-foreground">{task.reason}</p>}
    <details className="mt-2 min-w-0" open={!working && task.status !== "completed"}>
      <summary className="cursor-pointer text-muted-foreground">Saved goal and checklist</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{task.goal}</p>
      {task.additionalRequests.map((request, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{request}</p>)}
      {task.planRequired && <p className="mt-2 text-amber-300">The checklist still needs to cover the request.</p>}
      <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto overscroll-contain">
        {task.requirements.map(item => <li key={item.id} className="flex gap-2"><span aria-label={item.verified ? "Verified" : "Pending"} className={item.verified ? "text-emerald-400" : "text-muted-foreground"}>{item.verified ? "✓" : "○"}</span><div className="min-w-0"><p className="break-words">{item.text}</p>{item.evidence.map((evidence, index) => <p key={index} className="mt-0.5 break-words text-[11px] text-muted-foreground">{evidence}</p>)}</div></li>)}
      </ul>
      {task.validationErrors.length > 0 && <p className="mt-2 break-words text-amber-300">{task.validationErrors.join("; ")}</p>}
    </details>
  </section>;
}
