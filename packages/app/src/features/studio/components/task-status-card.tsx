import type { StudioTask } from "@yumina/shared";
import { Check, Circle, Loader2, Play } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { describeTaskCheck, taskCheckPassed } from "../lib/task-progress";

const labels: Record<StudioTask["status"], string> = {
  working: "In progress", waiting: "Waiting", completed: "Complete", needs_input: "Needs your answer",
  stalled: "Paused", budget_paused: "Step limit reached", stopped: "Stopped", interrupted: "Interrupted",
};

export function TaskStatusCard({ task, working, onContinue, allowContinue = true }: { task: StudioTask; working: boolean; allowContinue?: boolean; onContinue: () => void }) {
  const world = useEditorStore(state => state.worldDraft);
  if (task.mode === "answer" && !task.requirements.length) return null;
  const total = task.requirements.length;
  const passed = task.requirements.filter(item => item.verified).length;
  const resumable = allowContinue && !working && ["stalled", "budget_paused", "interrupted", "stopped"].includes(task.status);

  return <section aria-label="Task progress" data-studio-task={task.status} className="my-3 min-w-0 rounded-xl border border-border bg-muted/20 p-3 text-xs sm:p-4">
    <div className="flex flex-wrap items-center gap-2">
      {working ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-primary" /> : task.status === "completed" ? <Check aria-hidden="true" className="h-4 w-4 text-emerald-400" /> : <Circle aria-hidden="true" className="h-4 w-4 text-muted-foreground" />}
      <span className="font-medium text-foreground">{labels[task.status]}</span>
      <span className="text-muted-foreground">{total ? `${passed} of ${total} complete` : working ? "Planning your task…" : "Checklist not ready"}</span>
      {resumable && <button type="button" onClick={onContinue} className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 text-primary hover:bg-primary/20 [@media(pointer:coarse)]:min-h-11"><Play aria-hidden="true" className="h-3 w-3" />Continue task</button>}
    </div>
    {total > 0 && <div role="progressbar" aria-label="Completed checklist items" aria-valuenow={passed} aria-valuemin={0} aria-valuemax={total} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${passed / total * 100}%` }} /></div>}
    {task.reason && <p className="mt-3 break-words leading-relaxed text-muted-foreground">{task.reason}</p>}

    {total > 0 && <details className="mt-3 min-w-0" open={task.status !== "completed"}>
      <summary className="cursor-pointer py-1 font-medium">Checklist</summary>
      <ul className="mt-2 max-h-80 space-y-3 overflow-y-auto overscroll-contain pr-1">
        {task.requirements.map(item => {
          const checks = item.checks.map((check, index) => ({ check, passed: taskCheckPassed(item.evidence[index]) }));
          const checked = checks.filter(check => check.passed !== null).length;
          const remaining = checks.filter(check => check.passed !== true).length;
          return <li key={item.id} className="flex gap-2.5">
            <span aria-label={item.verified ? "Complete" : "To do"} className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${item.verified ? "bg-emerald-400/15 text-emerald-400" : "border border-border text-muted-foreground"}`}>{item.verified && <Check aria-hidden="true" className="h-3 w-3" />}</span>
            <div className="min-w-0 flex-1">
              <p className="break-words leading-relaxed">{item.text}</p>
              <p className={`mt-1 text-[11px] ${item.verified ? "text-emerald-400" : "text-muted-foreground"}`}>{item.verified ? "Complete" : !checks.length ? "Needs a check before it can be confirmed" : !checked ? "Not checked yet" : remaining ? `${remaining} ${remaining === 1 ? "check" : "checks"} still to do` : "Awaiting confirmation"}</p>
              {(checks.length > 0 || item.evidence.length > 0) && <details className="mt-1 min-w-0 text-muted-foreground">
                <summary className="cursor-pointer py-1 text-[11px] hover:text-foreground">View checks</summary>
                <ul className="mt-1 space-y-2">
                  {checks.map(({ check, passed: checkPassed }, index) => <li key={index} className="flex gap-2 text-[11px] leading-relaxed">
                    <span className="shrink-0 font-medium">{checkPassed === true ? "Done:" : checkPassed === false ? "To do:" : "Check:"}</span>
                    <span className="min-w-0 break-words">{describeTaskCheck(check, world)}</span>
                  </li>)}
                </ul>
                {item.evidence.length > 0 && <details className="mt-2 min-w-0">
                  <summary className="cursor-pointer py-1 text-[11px] hover:text-foreground">Technical details</summary>
                  <div className="mt-1 rounded-md bg-background/50 p-2 font-mono text-[10px] leading-relaxed">{item.evidence.map((evidence, index) => <p key={index} className="break-words [overflow-wrap:anywhere]">{evidence}</p>)}</div>
                </details>}
              </details>}
            </div>
          </li>;
        })}
      </ul>
    </details>}
    {task.planRequired && <p className="mt-3 text-muted-foreground">The checklist still needs to cover your latest request.</p>}
    {task.validationErrors.length > 0 && <details className="mt-3 text-amber-300">
      <summary className="cursor-pointer py-1">{task.validationErrors.length} {task.validationErrors.length === 1 ? "card issue needs" : "card issues need"} attention</summary>
      <ul className="mt-1 list-inside list-disc space-y-1">{task.validationErrors.map((error, index) => <li key={index} className="break-words [overflow-wrap:anywhere]">{error}</li>)}</ul>
    </details>}
    <details className="mt-3 min-w-0 border-t border-border/60 pt-2 text-muted-foreground">
      <summary className="cursor-pointer py-1">Your request</summary>
      <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{task.goal}</p>
      {task.additionalRequests.map((request, index) => <p key={index} className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{request}</p>)}
      <p className="mt-2 text-[11px]">{task.steps} agent {task.steps === 1 ? "step" : "steps"}{task.maxSteps ? ` · limit ${task.maxSteps}` : ""}</p>
    </details>
  </section>;
}
