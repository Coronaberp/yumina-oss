import type { StudioChatMessage, ChatAttachment } from "./types";

export interface StudioSteeringItem {
  id: string;
  content: string;
  createdAt: string;
  status: "queued" | "applied" | "failed";
  beforeIteration?: number;
  attachments?: ChatAttachment[];
}

/** Server events can arrive before their HTTP acknowledgement. Applied input
 * must never turn back into queued input when that older acknowledgement lands. */
export function mergeStudioSteering(messages: StudioChatMessage[], runId: string, items: unknown): StudioChatMessage[] {
  if (!Array.isArray(items)) return messages;
  const result = [...messages];
  for (const item of items as StudioSteeringItem[]) {
    if (!item || typeof item.id !== "string" || typeof item.content !== "string" || typeof item.createdAt !== "string"
      || !["queued", "applied", "failed"].includes(item.status)) continue;
    const index = result.findIndex(message => message.id === item.id && message.agentRunId === runId && message.steering);
    if (index >= 0 && item.status === "queued" && result[index]!.steering!.status === "applied") continue;
    const message: StudioChatMessage = { id: item.id, role: "user", content: item.content, agentRunId: runId,
      ...(item.attachments?.length ? { attachments: item.attachments } : index >= 0 && result[index]!.attachments ? { attachments: result[index]!.attachments } : {}),
      steering: { status: item.status, createdAt: item.createdAt, beforeIteration: item.beforeIteration } };
    if (index >= 0) result[index] = message;
    else result.push(message);
  }
  return result;
}

/** Undo snapshots belong to the whole run, including its follow-up requests. */
export function studioTaskStart(messages: StudioChatMessage[], lastUserIndex: number): number {
  const runId = messages[lastUserIndex]?.steering ? messages[lastUserIndex]?.agentRunId : undefined;
  if (!runId) return lastUserIndex;
  let index = lastUserIndex;
  while (index > 0) {
    index--;
    if (messages[index]!.role === "user" && !messages[index]!.steering) return index;
  }
  return lastUserIndex;
}
