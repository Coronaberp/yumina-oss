import { configuredImageJobs } from "../configured-image-jobs.js";
import { imageToolMessages, type ImageProposal } from "./image-proposal.js";
import type { ToolCall, ChatMessage } from "../llm/types.js";

/** Called by creator confirmation, inside the stopped/run-aware stream. */
export async function waitForConfiguredImage(options: {
  call: ToolCall; proposal: ImageProposal; userId: string; runId: string; worldId: string;
  send(event: string, data: string): Promise<void>; progress(): void; signal: AbortSignal;
}): Promise<ChatMessage[]> {
  const { call, proposal, userId, runId, worldId, send, progress, signal } = options;
  try {
    signal.throwIfAborted();
    const job = await configuredImageJobs.submit({ userId, worldId, runId, callId: call.id, proposal });
    progress();
    await send("image_progress", JSON.stringify({ runId, toolCallId: call.id, jobId: job.jobId, status: "generating", elapsed: job.elapsed }));
    return imageToolMessages(call, { status: "success", result: { status: job.status, jobId: job.jobId,
      help: "The approved image is queued in the background, including its safety check. Continue independent work now. Use get_image_job when you need its saved @asset ref. Do not poll repeatedly, regenerate it or claim it is finished before success. The image card updates independently." } });
  } catch (error) {
    if (signal.aborted) throw error;
    const code = error instanceof Error && error.message.includes("NSFW") ? "NSFW_IMAGE_REQUEST"
      : error && typeof error === "object" && "code" in error ? String(error.code) : "GENERATION_FAILED";
    await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId: null, status: "failed", errorCode: code }));
    return imageToolMessages(call, { status: "error", result: null,
      error: error instanceof Error && error.message.includes("NSFW") ? error.message
        : `Configured image generation failed (${code}). ${error instanceof Error ? error.message : "Check the image connection."} Do not retry automatically; tell the creator and end this turn.` });
  }
}
