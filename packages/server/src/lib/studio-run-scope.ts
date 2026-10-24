import { and, eq, isNull, ne, sql, desc } from "drizzle-orm";
import { readStudioTask } from "@yumina/shared";
import { db } from "../db/index.js";
import { agentRuns, studioConversations, worlds } from "../db/schema.js";
import { writeStudioWorldSchema } from "./pending-edit.js";

/** A card may have several workers. Only one worker owns a given chat. */
export function studioConversationScope(conversationId: string | null | undefined) {
  return conversationId ? eq(agentRuns.conversationId, conversationId) : isNull(agentRuns.conversationId);
}

export async function createScopedStudioRun(values: typeof agentRuns.$inferInsert, clarification?: string) {
  return db.transaction(async tx => {
    const [world] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, values.worldId), eq(worlds.creatorId, values.userId))).for("update");
    if (!world) throw new Error("World not found");
    if (values.conversationId) {
      const [conversation] = await tx.select({ id: studioConversations.id }).from(studioConversations).where(and(
        eq(studioConversations.id, values.conversationId), eq(studioConversations.worldId, values.worldId), eq(studioConversations.userId, values.userId),
      ));
      if (!conversation) throw new Error("Conversation not found");
    }
    if (clarification) {
      const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.worldId, values.worldId), eq(agentRuns.userId, values.userId), studioConversationScope(values.conversationId))).orderBy(desc(agentRuns.createdAt)).limit(1);
      const task = readStudioTask(prior?.context);
      if (prior?.status === "awaiting_user" && task?.status === "needs_input") {
        task.additionalRequests = [...task.additionalRequests, clarification].slice(-100);
        task.planRequired = true; task.met = false; task.status = "working"; delete task.reason;
        values = { ...values, context: { ...values.context, studioTask: task } };
      }
    }
    const superseded = await tx.update(agentRuns).set({ status: "error", error: "Superseded by a new request in this conversation.", updatedAt: new Date(),
      context: sql`CASE WHEN ${agentRuns.context}->'studioTask' IS NOT NULL THEN jsonb_set(${agentRuns.context}, '{studioTask,status}', '"stopped"'::jsonb) ELSE ${agentRuns.context} END` })
      .where(and(eq(agentRuns.worldId, values.worldId), eq(agentRuns.userId, values.userId), studioConversationScope(values.conversationId), eq(agentRuns.status, "running")))
      .returning();
    const [run] = await tx.insert(agentRuns).values(values).returning();
    return { run: run!, supersededIds: superseded.map(prior => prior.id) };
  });
}

export async function resumeScopedStudioApproval(scope: { worldId: string; userId: string; runId: string }) {
  return db.transaction(async tx => {
    const [world] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, scope.worldId), eq(worlds.creatorId, scope.userId))).for("update");
    if (!world) return { run: undefined, blocked: false };
    const target = and(eq(agentRuns.id, scope.runId), eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId));
    const [stored] = await tx.select().from(agentRuns).where(target).for("update");
    if (!stored || stored.status !== "awaiting_approval") return { run: undefined, blocked: false };
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId), studioConversationScope(stored.conversationId), ne(agentRuns.id, scope.runId), eq(agentRuns.status, "running"),
    )).limit(1);
    if (active) return { run: undefined, blocked: true };
    const [run] = await tx.update(agentRuns).set({ status: "running", updatedAt: new Date() }).where(target).returning();
    return { run, blocked: false };
  });
}

/** Serialize saves, reject stale snapshots, and fence stopped/replaced workers. */
export async function writeScopedStudioWorldSchema(args: {
  worldId: string; userId: string; runId: string;
  schema: Record<string, unknown>; expectedSchema: Record<string, unknown>;
  thumbnailUrl?: string | null; expectedThumbnailUrl?: string | null;
}) {
  return db.transaction(async tx => {
    const [world] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, args.worldId), eq(worlds.creatorId, args.userId))).for("update");
    if (!world) throw new Error("World not found");
    const [run] = await tx.select({ status: agentRuns.status }).from(agentRuns).where(and(
      eq(agentRuns.id, args.runId), eq(agentRuns.worldId, args.worldId), eq(agentRuns.userId, args.userId),
    )).for("update");
    if (run?.status !== "running") throw new Error("STUDIO_RUN_NO_LONGER_ACTIVE");
    return writeStudioWorldSchema({ worldId: args.worldId, creatorId: args.userId, schema: args.schema, expectedSchema: args.expectedSchema,
      thumbnailUrl: args.thumbnailUrl, expectedThumbnailUrl: args.expectedThumbnailUrl, database: tx });
  });
}
