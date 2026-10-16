import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, generationJobs, user, worlds } from "../db/schema.js";
import { studioConversationScope } from "./studio-run-scope.js";
import { resolveStudioNsfwProvider } from "./studio-nsfw-provider.js";
import { resolveWorkingSchema } from "./pending-edit.js";
import { migrateWorldDefinition } from "@yumina/engine";
import type { AgentLoopParams } from "../routes/agent.js";
import { imageCompletionTurn } from "./studio-tools/harness-notes.js";
import type { WorldDefinition } from "@yumina/engine";

type Connection = Pick<NonNullable<Awaited<ReturnType<typeof resolveStudioNsfwProvider>>>, "provider" | "model" | "isByok" | "apiKeyTier">;
type NotificationParams = Omit<AgentLoopParams, "tools" | "unlimited">;
type Event = { event: string; data: string };
const channels = new Map<string, Set<(event: Event) => void>>();
const channelKey = (userId: string, worldId: string, conversationId: string | null) => JSON.stringify([userId, worldId, conversationId]);

export function subscribeStudioImageNotifications(userId: string, worldId: string, conversationId: string | null, listener: (event: Event) => void) {
  const key = channelKey(userId, worldId, conversationId);
  const listeners = channels.get(key) ?? new Set();channels.set(key, listeners);listeners.add(listener);
  return () => { listeners.delete(listener);if (!listeners.size) channels.delete(key); };
}

export function publishStudioImageNotification(userId: string, worldId: string, conversationId: string | null, event: string, data: string) {
  for (const listener of channels.get(channelKey(userId, worldId, conversationId)) ?? []) listener({ event, data });
}

/** A notification is claimed together with its fresh run under the same world
 * lock as user-started runs. Images never hold an agent turn open. */
export function createStudioImageNotifications(launch?: (params: NotificationParams) => Promise<void>, resolve = resolveStudioNsfwProvider as (userId: string) => Promise<Connection | null>) {
  const dispatching = new Map<string, Promise<void>>();
  const notify = (userId: string, worldId: string, taskRunId: string): Promise<void> => {
    if (!launch) return Promise.resolve();
    const key = JSON.stringify([userId, worldId, taskRunId]);
    if (dispatching.has(key)) return dispatching.get(key)!;
    const operation = (async () => {
      // Resolve credentials afresh; never retain a provider across background jobs.
      const resolved = await resolve(userId);
      if (!resolved) return;
      const claimed = await db.transaction(async tx => {
        const [owned] = await tx.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).for("update");
        const [account] = await tx.select({ suspended: user.isSuspended }).from(user).where(eq(user.id, userId));
        if (!owned || !account || account.suspended) return null;
        const [source] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, taskRunId), eq(agentRuns.userId, userId), eq(agentRuns.worldId, worldId)));
        if (!source) return null;
        const jobs = await tx.select().from(generationJobs).where(and(eq(generationJobs.userId, userId), eq(generationJobs.templateId, "studio-configured-image"),
          sql`${generationJobs.params}->>'worldId' = ${worldId}`, sql`${generationJobs.params}->>'runId' = ${taskRunId}`,
          sql`${generationJobs.params}->>'notifyAgent' = 'true'`, sql`${generationJobs.params}->>'notificationRunId' IS NULL`,
          sql`${generationJobs.params}->>'notificationSkipped' IS NULL`, inArray(generationJobs.status, ["succeeded", "failed"]))).for("update");
        if (!jobs.length) return null;
        const [latest] = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.worldId, worldId), studioConversationScope(source.conversationId))).orderBy(desc(agentRuns.createdAt)).limit(1);
        const origin = (latest?.context?.studioImageNotification as { taskRunId?: string } | undefined)?.taskRunId;
        const superseded = latest && latest.id !== taskRunId && origin !== taskRunId;
        if (superseded || /stopped by user|superseded/i.test(source.error ?? "") || (origin === taskRunId && /stopped by user|superseded/i.test(latest?.error ?? ""))) {
          for (const job of jobs) await tx.update(generationJobs).set({ params: { ...job.params, notificationSkipped: "task_stopped_or_superseded" } }).where(eq(generationJobs.id, job.id));
          return null;
        }
        // The completion hook on the active turn delivers these after it ends.
        if (source.status !== "completed" || !latest || latest.status !== "completed" || resolved.model !== source.model) return null;
        const results = jobs.map(job => ({ jobId: job.id, status: job.status, purpose: (job.params.proposal as { purpose?: string } | undefined)?.purpose,
          refs: job.status === "succeeded" ? (job.assetIds ?? (job.assetId ? [job.assetId] : [])).map(id => `@asset:${id}`) : [],
          errorCode: job.errorCode, error: job.errorMessage }));
        const notification = imageCompletionTurn(results);
        const messages = [...(latest.messages ?? []), notification];
        const context = { activePanel: source.context?.activePanel, selectedElementId: source.context?.selectedElementId,
          selectedElementType: source.context?.selectedElementType, studioToolTrace: [],
          studioImageNotification: { taskRunId, jobIds: jobs.map(job => job.id) } };
        const [run] = await tx.insert(agentRuns).values({ userId, worldId, conversationId: source.conversationId,
          status: "running", model: source.model, messages: messages as unknown as Array<Record<string, unknown>>,
          context, iteration: 0, maxIterations: source.maxIterations }).returning();
        for (const job of jobs) await tx.update(generationJobs).set({ params: { ...job.params, notificationRunId: run!.id } }).where(eq(generationJobs.id, job.id));
        return { run: run!, world: owned };
      });
      if (!claimed) return;
      const { run, world } = claimed;
      try {
        const schema = await resolveWorkingSchema(worldId, world.status, world.schema as Record<string, unknown>);
        publishStudioImageNotification(userId, worldId, run.conversationId, "agent_notification", JSON.stringify({ runId: run.id, model: run.model, taskRunId }));
        // Dispatch independently: the image worker releases its slot immediately.
        void launch!({ runId: run.id, conversationId: run.conversationId ?? taskRunId, worldId, userId,
          world: migrateWorldDefinition(schema as unknown as WorldDefinition), messages: run.messages as unknown as AgentLoopParams["messages"],
          model: run.model, provider: resolved.provider, isByok: resolved.isByok, apiKeyTier: resolved.apiKeyTier,
          context: run.context as AgentLoopParams["context"], imageNotification: true, iteration: 0, maxIterations: run.maxIterations }).catch(async error => {
          await db.update(agentRuns).set({ status: "error", error: error instanceof Error ? error.message.slice(0, 500) : "Image notification continuation failed", updatedAt: new Date() })
            .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, "running")));
          publishStudioImageNotification(userId, worldId, run.conversationId, "error", JSON.stringify({ error: "The image finished, but the agent continuation failed. The saved image is still available." }));
        });
      } catch (error) {
        await db.update(agentRuns).set({ status: "error", error: error instanceof Error ? error.message.slice(0, 500) : "Image notification setup failed", updatedAt: new Date() }).where(eq(agentRuns.id, run.id));
      }
    })().finally(() => dispatching.delete(key));
    dispatching.set(key, operation);return operation;
  };
  return { notify, setLauncher(value: NonNullable<typeof launch>) { launch = value; } };
}

export const studioImageNotifications = createStudioImageNotifications();
