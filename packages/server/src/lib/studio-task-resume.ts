import { and, eq, ne } from "drizzle-orm";
import { readStudioTask } from "@yumina/shared";
import { db } from "../db/index.js";
import { agentRuns, worlds } from "../db/schema.js";
import { withStudioUserMessageContext } from "./studio-conversations.js";
import { studioConversationScope } from "./studio-run-scope.js";
import { captureStudioWorldRevisionInTransaction } from "./studio-credit-checkpoint.js";

export async function claimStudioTaskResume(scope: { worldId: string; userId: string; runId: string }, model: string) {
  return db.transaction(async tx => {
    const [owned] = await tx.select({ id: worlds.id }).from(worlds).where(and(eq(worlds.id, scope.worldId), eq(worlds.creatorId, scope.userId))).for("update");
    if (!owned) return { ok: false as const, code: "NOT_FOUND" };
    const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, scope.runId), eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId))).for("update");
    if (!prior) return { ok: false as const, code: "NOT_FOUND" };
    const task = readStudioTask(prior.context);
    if (!task || !["stalled", "budget_paused", "interrupted", "stopped"].includes(task.status) || !["error", "awaiting_user"].includes(prior.status) || prior.creditCheckpoint)
      return { ok: false as const, code: "NOT_RESUMABLE" };
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId), studioConversationScope(prior.conversationId), ne(agentRuns.id, prior.id), eq(agentRuns.status, "running"))).limit(1);
    if (active) return { ok: false as const, code: "ACTIVE_RUN" };
    if (prior.context?.studioTaskResumedBy) return { ok: false as const, code: "ALREADY_RESUMED" };
    task.status = "working"; task.met = false; delete task.reason;
    task.progress.noProgress = 0; task.progress.recoveries = 0;
    if (task.maxSteps) task.maxSteps += Math.max(1, Number(prior.context?.studioTaskStepAllowance) || task.maxSteps - Number(prior.context?.studioTaskResumedAtStep ?? 0));
    const snapshot = await captureStudioWorldRevisionInTransaction(tx, scope);
    const id = crypto.randomUUID();
    const stepAllowance = task.maxSteps ? task.maxSteps - task.steps : undefined;
    const [run] = await tx.insert(agentRuns).values({id, worldId: scope.worldId, userId: scope.userId, conversationId: prior.conversationId, status:"running", model,
      messages: [...prior.messages, { role:"user", content:"Continue the original saved task and all its requirements from the card as it is now. Recheck saved outcomes before finishing." }],
      iteration:0,maxIterations:50,context:withStudioUserMessageContext({...prior.context,studioTask:task,studioTaskRunner:true,studioTaskParent:prior.id,studioTaskStepAllowance:stepAllowance,studioTaskResumedAtStep:task.steps,
        studioTaskResumedBy:undefined,studioToolTrace:[],studioSteering:[]}, {role:"user",content:"Continue the saved task."}),
    }).returning();
    await tx.update(agentRuns).set({context:{...prior.context,studioTaskResumedBy:id},updatedAt:new Date()}).where(eq(agentRuns.id,prior.id));
    return {ok:true as const,run:run!,schema:snapshot.schema};
  });
}
