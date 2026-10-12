import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, worlds } from "../db/schema.js";
import type { ChatMessage } from "./llm/types.js";
import { normalizeStudioChatReferences, type StudioImageReference } from "./studio-image-references.js";

export const STUDIO_STEERING_KEY = "studioSteering";
export interface StudioSteeringMessage {
  id: string;
  content: string;
  createdAt: string;
  status: "queued" | "applied" | "failed";
  beforeIteration?: number;
  attachments?: Array<StudioImageReference & { mimeType: string }>;
}
export interface StudioSteeringScope {
  userId: string;
  worldId: string;
  runId: string;
  conversationId: string | null;
}
export class StudioSteeringError extends Error {
  constructor(public code: string, public httpStatus: 400 | 404 | 409 = 409) { super(code); }
}

export function readStudioSteering(context: unknown, status?: string): StudioSteeringMessage[] {
  const items = (context as Record<string, unknown> | null)?.[STUDIO_STEERING_KEY];
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is StudioSteeringMessage => !!item && typeof item.id === "string"
    && typeof item.content === "string" && typeof item.createdAt === "string"
    && ["queued", "applied", "failed"].includes(item.status)).map(item => ({ ...item,
      ...(item.status === "queued" && (status === "completed" || status === "error") ? { status: "failed" as const } : {}),
    }));
}

/** Called only at a completed tool/answer boundary, inside the run-row lock.
 * The transcript and next paid checkpoint are persisted with this context. */
export function consumeStudioSteering(context: Record<string, unknown> | null, messages: ChatMessage[], beforeIteration: number) {
  const items = readStudioSteering(context);
  const pending = items.filter(item => item.status === "queued");
  const applied = pending.map(item => ({ ...item, status: "applied" as const, beforeIteration }));
  return {
    items: applied,
    context: { ...context, [STUDIO_STEERING_KEY]: items.map(item => applied.find(next => next.id === item.id) ?? item) },
    messages: [...messages, ...applied.map(item => ({ role: "user" as const, content: item.attachments?.length
      ? [{ type: "text" as const, text: item.content }, ...item.attachments.map(image => ({ type: "image_url" as const, image_url: { url: image.url } }))]
      : item.content }))],
  };
}

/** Accepts no provider work and never replaces the worker. The shared row lock
 * orders acceptance against natural completion, including across replicas. */
export async function enqueueStudioSteering(scope: StudioSteeringScope, id: string, content: string, uploads?: unknown) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) || !content.trim() || content.length > 16_000) {
    throw new StudioSteeringError("INVALID_STEERING", 400);
  }
  const attachments = normalizeStudioChatReferences(scope.userId, uploads).map(ref => ({ ...ref,
    mimeType: (uploads as Array<{ key: string; mimeType: string }>).find(upload => upload.key === ref.key)!.mimeType }));
  return db.transaction(async tx => {
    const [world] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, scope.worldId), eq(worlds.creatorId, scope.userId))).for("update");
    if (!world) throw new StudioSteeringError("RUN_NOT_FOUND", 404);
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, scope.runId),
      eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId))).for("update");
    if (!run || run.conversationId !== scope.conversationId) throw new StudioSteeringError("RUN_NOT_FOUND", 404);
    const items = readStudioSteering(run.context, run.status);
    const existing = items.find(item => item.id === id);
    if (existing) {
      if (existing.content !== content.trim() || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(attachments)) throw new StudioSteeringError("STEERING_ID_CONFLICT");
      return existing;
    }
    if (run.status !== "running") throw new StudioSteeringError("RUN_FINISHED");
    if (items.length >= 50) throw new StudioSteeringError("STEERING_LIMIT");
    const item: StudioSteeringMessage = { id, content: content.trim(), createdAt: new Date().toISOString(), status: "queued",
      ...(attachments.length ? { attachments } : {}) };
    await tx.update(agentRuns).set({ context: { ...run.context, [STUDIO_STEERING_KEY]: [...items, item] }, updatedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
    return item;
  });
}
