import { SMART_IMAGE_ASPECTS, SMART_IMAGE_MODEL, SMART_IMAGE_MODEL_IDS, getSmartImageModel,
  resolveSmartImageAspect, resolveSmartImageResolution } from "@yumina/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { generationJobs } from "../../db/schema.js";
import type { ChatMessage, ToolCall } from "../llm/types.js";
import type { ToolResult } from "./index.js";
import { buildToolResultMessages } from "./tool-results.js";
import type { StudioImageReference, StudioImageTarget } from "../studio-image-references.js";

/**
 * `generate_image` is a control tool: the model proposes, the creator confirms
 * in the chat, and only then does the server create a paid job on the
 * creator's behalf. This module holds the pieces both the pause (agent loop)
 * and the resume (confirm route) share.
 */
export const IMAGE_TOOL_NAME = "generate_image";

export type ImageAspect = (typeof SMART_IMAGE_ASPECTS)[number];
export type StudioImageWorkflowChoice = "anima" | "krea" | "codex";

export function defaultStudioImageWorkflow(options: {
  requested?: StudioImageWorkflowChoice; contentRating: "sfw" | "nsfw"; hasReferences: boolean;
  imageKind: "sprite" | "background" | "image"; available: { anima: boolean; krea: boolean; codex: boolean };
  activeSource?: "comfyui" | "forgeneo" | "codex"; animaPreferred?: boolean;
}): StudioImageWorkflowChoice | undefined {
  if (options.requested && !(options.contentRating === "nsfw" && options.requested === "codex")) return options.requested;
  if (options.contentRating === "nsfw") return options.available.krea ? "krea" : undefined;
  if (options.available.codex) return "codex";
  if (options.animaPreferred && options.available.anima && ["sprite", "background"].includes(options.imageKind)) return "anima";
  if (options.hasReferences) return options.available.codex ? "codex" : options.available.krea ? "krea" : undefined;
  if (options.activeSource === "codex" && options.available.codex) return "codex";
  if (options.activeSource === "comfyui" && options.available.anima) return "anima";
  if (options.available.codex) return "codex";
  return undefined;
}

export interface ImageProposal {
  prompt: string;
  referenceImages?: StudioImageReference[];
  target?: StudioImageTarget;
  styleInstructions?: string;
  outfitInstructions?: string;
  unassignedReason?: string;
  /** Configured personal generator; absent keeps the platform flow. */
  source?: "comfyui" | "forgeneo" | "codex";
  imageWorkflow?: "anima" | "krea" | "codex";
  contentRating?: "sfw" | "nsfw";
  imageKind?: "sprite" | "background" | "image";
  transparent?: boolean;
  /** Server-selected local Anima workflow and creator's per-request checkpoint. */
  animaEnabled?: boolean;
  animaModel?: string;
  animaModels?: Array<{ name: string; nsfwCapable: boolean }>;
  workflowOptions?: { anima: boolean; krea: boolean; codex: boolean };
  seedMode?: "random" | "fixed";
  seed?: number;
  cfg?: number;
  steps?: number;
  /** What the picture is for, in the creator's words — shown on the card. */
  purpose?: string;
  /** Which generator to run. The assistant chooses; an unknown value falls back
   *  to the default rather than reaching a provider that does not exist. */
  model: string;
  /** Why that generator, in the creator's language. Rendered on the card in a
   *  fixed slot rather than left to the assistant's prose, so the disclosure
   *  happens every time and reads the same way. */
  modelReason?: string;
  aspectRatio: ImageAspect;
  /** Output size tier. Absent means the chosen model's own default. */
  resolution?: string;
  batchSize: number;
}

const MAX_PROMPT = 2000;

/** Shape-check the model's (or the creator's edited) arguments. Null = unusable. */
export function normalizeImageProposal(raw: unknown): ImageProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return null;
  let referenceImages: StudioImageReference[] | undefined;
  if (r.referenceImages !== undefined) {
    if (!Array.isArray(r.referenceImages) || r.referenceImages.length > 5 || r.referenceImages.some(ref =>
      !ref || typeof ref.key !== "string" || typeof ref.url !== "string" || typeof ref.name !== "string"
      || (ref.assetRef !== undefined && typeof ref.assetRef !== "string")
      || (ref.role !== undefined && !["identity", "environment", "style", "creator"].includes(ref.role))
      || (ref.origin !== undefined && !["upload", "manual", "automatic"].includes(ref.origin)))) return null;
    referenceImages = r.referenceImages.map(ref => ({ key: ref.key, url: ref.url, name: ref.name,
      ...(typeof ref.assetRef === "string" ? { assetRef: ref.assetRef } : {}),
      ...(typeof ref.role === "string" ? { role: ref.role as StudioImageReference["role"] } : {}),
      ...(typeof ref.origin === "string" ? { origin: ref.origin as StudioImageReference["origin"] } : {}) }));
  }
  const legacyOpenAI = r.source === "openai";
  const source = r.source === "codex" ? "codex" : r.source === "comfyui" ? "comfyui" : r.source === "forgeneo" || legacyOpenAI ? "forgeneo" : undefined;
  const imageKind = r.imageKind === "background" || r.imageKind === "image" ? r.imageKind : "sprite";
  if (r.transparent === true && imageKind !== "sprite") return null;
  if (source) {
    const imageWorkflow = r.imageWorkflow === "anima" || r.imageWorkflow === "krea" || r.imageWorkflow === "codex"
      ? r.imageWorkflow : source === "codex" ? "codex" : source === "comfyui" && r.animaEnabled === true ? "anima" : undefined;
    const seedMode = r.seedMode === "fixed" ? "fixed" : "random";
    const seed = typeof r.seed === "number" && Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= Number.MAX_SAFE_INTEGER ? r.seed : undefined;
    const contentRating = r.contentRating === "nsfw" ? "nsfw" : "sfw";
    const transparent = imageKind === "sprite" && r.transparent === true;
    const cfg = typeof r.cfg === "number" && Number.isFinite(r.cfg) ? Math.min(8, Math.max(0.5, r.cfg)) : 1;
    const steps = typeof r.steps === "number" && Number.isInteger(r.steps) ? Math.min(20, Math.max(1, r.steps)) : 8;
    const workflowOptions = r.workflowOptions && typeof r.workflowOptions === "object" ? r.workflowOptions as ImageProposal["workflowOptions"] : undefined;
    return { prompt, source, imageKind, model: source === "codex" ? "GPT-6.1 Sol · xhigh" : legacyOpenAI ? "Forge Neo" : typeof r.model === "string" ? r.model.slice(0, 120) : source,
      ...(imageWorkflow ? { imageWorkflow } : {}), contentRating, transparent,
      ...(typeof r.animaModel === "string" && /^[\p{L}\p{N} _().+-]{1,180}\.safetensors$/iu.test(r.animaModel) ? { animaModel: r.animaModel } : {}),
      ...(r.animaEnabled === true ? { animaEnabled: true } : {}),
      ...(Array.isArray(r.animaModels) ? { animaModels: r.animaModels.filter((model): model is { name: string; nsfwCapable: boolean } =>
        !!model && typeof model === "object" && typeof model.name === "string" && typeof model.nsfwCapable === "boolean").slice(0, 200) } : {}),
      ...(workflowOptions ? { workflowOptions } : {}), seedMode, ...(seed !== undefined ? { seed } : {}), cfg, steps,
      ...(referenceImages?.length ? { referenceImages } : {}),
      ...(r.target && typeof r.target === "object" ? { target: r.target as StudioImageTarget } : {}),
      ...(typeof r.outfitInstructions === "string" ? { outfitInstructions: r.outfitInstructions.slice(0, 3000) } : {}),
      ...(typeof r.styleInstructions === "string" ? { styleInstructions: r.styleInstructions.slice(0, 5000) } : {}),
      ...(typeof r.unassignedReason === "string" ? { unassignedReason: r.unassignedReason.slice(0, 300) } : {}),
      ...(typeof r.purpose === "string" ? { purpose: r.purpose.trim().slice(0, 200) } : {}), aspectRatio: "1:1", batchSize: 1 };
  }
  // Resolve the model first: everything else is narrowed against IT, not against
  // the union the schema advertises. A model rejects a ratio it does not know,
  // and the creator would only find out after confirming the card.
  const model = typeof r.model === "string" && (SMART_IMAGE_MODEL_IDS as readonly string[]).includes(r.model)
    && getSmartImageModel(r.model)
    ? r.model
    : SMART_IMAGE_MODEL;
  const aspect = resolveSmartImageAspect(model,
    typeof r.aspectRatio === "string" ? r.aspectRatio : undefined) as ImageAspect;
  const resolution = resolveSmartImageResolution(model,
    typeof r.resolution === "string" ? r.resolution : undefined);
  void SMART_IMAGE_ASPECTS;
  const batchRaw = typeof r.batchSize === "number" ? r.batchSize : Number(r.batchSize ?? 1);
  const batchSize = Number.isFinite(batchRaw) ? Math.min(4, Math.max(1, Math.round(batchRaw))) : 1;
  const purpose = typeof r.purpose === "string" && r.purpose.trim() ? r.purpose.trim().slice(0, 200) : undefined;
  const modelReason = typeof r.modelReason === "string" && r.modelReason.trim()
    ? r.modelReason.trim().slice(0, 160) : undefined;
  return { prompt, purpose, model, ...(modelReason ? { modelReason } : {}),
    aspectRatio: aspect, ...(resolution ? { resolution } : {}), ...(r.imageKind ? { imageKind } : {}), batchSize };
}

export function imageToolMessages(call: ToolCall, result: Omit<ToolResult, "tool_call_id" | "name">): ChatMessage[] {
  return buildToolResultMessages([{ tool_call_id: call.id, name: IMAGE_TOOL_NAME, ...result }]) as unknown as ChatMessage[];
}

const POLL_MS = 2_000;

/**
 * Follows a submitted job until it settles, narrating progress to the client,
 * and returns the tool messages the model continues with. A job that outlives
 * the wait is not an error: the image still lands in the library, and the model
 * is told to say so rather than retry.
 */
export async function waitForGeneratedImage(opts: {
  call: ToolCall;
  jobId: string;
  runId: string;
  folderId: string | null;
  send: (event: string, data: string) => Promise<void>;
  progress: () => void;
  timeoutMs?: number;
}): Promise<ChatMessage[]> {
  const { call, jobId, runId, folderId, send, progress } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);
  const startedAt = Date.now();
  let lastStatus = "";
  for (;;) {
    const [job] = await db.select({
      status: generationJobs.status, assetIds: generationJobs.assetIds, assetId: generationJobs.assetId,
      costMushies: generationJobs.costMushies, errorCode: generationJobs.errorCode, refundAmount: generationJobs.refundAmount,
    }).from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job) {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: "JOB_MISSING" }));
      return imageToolMessages(call, { status: "error", result: null, error: "The image job disappeared before it finished. Tell the creator and continue without it." });
    }
    progress();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (job.status === "succeeded") {
      const assetIds = job.assetIds?.length ? job.assetIds : job.assetId ? [job.assetId] : [];
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "done", assetIds, costMushies: job.costMushies }));
      return imageToolMessages(call, { status: "success", result: {
        delivered: assetIds.length,
        assets: assetIds.map((id) => ({ assetId: id, ref: `@asset:${id}` })),
        costMushies: job.costMushies,
        folderId,
        note: "The creator has already seen the image in the chat. Reference it by its ref only. If it belongs in custom UI or an entry, place it there with edit_custom_ui / write_entry. For a requested card portrait cover or page banner, read world-media and assign its owned ref with write_world_media using portraitAssetRef or bannerAssetRef respectively. Preserve the other image and framing. One short sentence, then end your turn.",
      } });
    }
    if (job.status === "failed" || job.status === "cancelled") {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: job.errorCode ?? job.status }));
      return imageToolMessages(call, { status: "error", result: null,
        error: `Image generation ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}. Any charge is refunded automatically. Do not call generate_image again in this turn: tell the creator plainly, ask whether to try again, and end your turn.` });
    }
    if (job.status !== lastStatus) {
      lastStatus = job.status;
    }
    await send("image_progress", JSON.stringify({ runId, toolCallId: call.id, jobId, status: job.status, elapsed }));
    if (Date.now() >= deadline) {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "pending" }));
      return imageToolMessages(call, { status: "success", result: {
        delivered: 0, pending: true, jobId, folderId,
        note: "The image is still generating after the wait limit. It will appear in the creator's asset library (and the bound folder) when done. Tell the creator that, do not retry, and continue.",
      } });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
