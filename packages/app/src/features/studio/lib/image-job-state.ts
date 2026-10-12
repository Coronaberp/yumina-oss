import type { StudioChatMessage, StudioImageProposal } from "./types";

/** Restore the same cards when their initial SSE event was lost. */
export function mergeStudioImageJobs(messages: StudioChatMessage[], jobs: unknown, restoreRunId?: string): StudioChatMessage[] {
  if (!Array.isArray(jobs)) return messages;
  const result = [...messages];
  for (const job of jobs) {
    const card = job?.card as StudioImageProposal | undefined;
    if (!card || typeof card.runId !== "string" || typeof card.toolCallId !== "string" || typeof card.jobId !== "string"
      || typeof card.prompt !== "string" || !["generating", "done", "failed", "cancelled"].includes(card.status)) continue;
    const index = result.findIndex(message => message.imageProposal?.runId === card.runId && message.imageProposal.toolCallId === card.toolCallId);
    if (index >= 0) result[index] = { ...result[index]!, imageProposal: card };
    else if (card.runId === restoreRunId) result.push({ id: `image-job-${card.jobId}`, role: "assistant", content: "", agentRunId: card.runId, imageProposal: card });
  }
  return result;
}
