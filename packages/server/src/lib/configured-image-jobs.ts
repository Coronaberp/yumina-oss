import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, generationJobs, worlds } from "../db/schema.js";
import { generateStudioImage } from "./image-generation/default.js";
import { generatedImageStorage } from "./image-generation/storage.js";
import { sessionMedia } from "./session-media.js";
import { mediaRows } from "./session-media-service.js";
import type { ImageProposal } from "./studio-tools/image-proposal.js";
import { studioImageReferenceGuidance } from "./studio-image-references.js";
import { integrateReadyStudioImageTasks } from "./studio-image-workflow.js";
import { animaModelSupportsNsfw, canChangeAnimaModel } from "./image-generation/anima-workflow.js";
import { studioImageNotifications } from "./studio-image-notifications.js";
import { CODEX_IMAGE_LABEL } from "./image-generation/codex-service.js";

const TEMPLATE = "studio-configured-image";
type Job = typeof generationJobs.$inferSelect;
type Options = { userId: string; worldId: string; runId: string; callId: string; proposal: ImageProposal };
const requestId = (runId: string, callId: string) => createHash("sha256").update(JSON.stringify([runId, callId])).digest("hex");
const describe = (job: Job) => {
  const params = job.params as unknown as Options & { referencePrepareUntil?: number; preparationUntil?: number; retryCount?: number;
    assetStatus?: string; assetReason?: string; taskPreflight?: unknown; progressPhase?: string; progressPercent?: number };
  const animaEnabled = params.proposal?.animaEnabled === true;
  const workflowEditable = job.status === "queued" && Number.isFinite(params.preparationUntil) && (params.preparationUntil ?? 0) > Date.now();
  return { jobId: job.id, status: job.status, source: params.proposal?.source, model: params.proposal?.model, assetIds: job.assetIds ?? [],
    refs: (job.assetIds ?? []).map(id => `@asset:${id}`), errorCode: job.errorCode, errorMessage: job.errorMessage,
    referenceImages: params.proposal?.referenceImages ?? [], referencePrepareUntil: params.referencePrepareUntil,
    referenceEditable: job.status === "queued" && (params.referencePrepareUntil ?? 0) > Date.now(), target: params.proposal?.target,
    animaEnabled, animaModel: params.proposal?.animaModel, animaModels: params.proposal?.animaModels,
    imageWorkflow: params.proposal?.imageWorkflow, contentRating: params.proposal?.contentRating, transparent: params.proposal?.transparent === true,
    workflowOptions: params.proposal?.workflowOptions, workflowEditable,
    seedMode: params.proposal?.seedMode, seed: params.proposal?.seed, cfg: params.proposal?.cfg, steps: params.proposal?.steps,
    generationOptionsEditable: workflowEditable,
    animaModelEditable: workflowEditable && (params.proposal?.imageWorkflow === "anima" || (animaEnabled && !params.proposal?.imageWorkflow)),
    progressPhase: params.progressPhase, progressPercent: params.progressPercent,
    assetStatus: params.assetStatus ?? (job.status === "succeeded" ? "generated" : job.status), assetReason: params.assetReason,
    retryCount: params.retryCount ?? 0, taskPreflight: params.taskPreflight,
    elapsed: Math.max(0, Math.floor(((job.completedAt ?? new Date()).getTime() - (job.startedAt ?? job.createdAt ?? new Date()).getTime()) / 1000)) };
};

/** Durable jobs use independent controllers: finishing/stopping a text turn
 * must not interrupt an image that has already started. */
export function createConfiguredImageJobs(generate = generateStudioImage) {
  const active = new Map<string, { userId: string; provider: string | null; controller: AbortController; promise: Promise<void> }>();
  let interval: ReturnType<typeof setInterval> | undefined, ticking = false, stopped = false;
  const get = async (userId: string, jobId: string, worldId?: string) => {
    const [job] = await db.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), eq(generationJobs.templateId, TEMPLATE)));
    return job && (worldId === undefined || job.params.worldId === worldId) ? describe(job) : null;
  };
  const submit = async (options: Options) => {
    const [run] = await db.select({ conversationId: agentRuns.conversationId }).from(agentRuns)
      .innerJoin(worlds, eq(worlds.id, agentRuns.worldId)).where(and(eq(agentRuns.id, options.runId),
        eq(agentRuns.userId, options.userId), eq(agentRuns.worldId, options.worldId), eq(worlds.creatorId, options.userId)));
    if (!run) throw new Error("Image run not found or not authorized.");
    if (!options.proposal.source) throw new Error("Choose a configured image provider.");
    const hash = requestId(options.runId, options.callId);
    const hasWorkflowChoices = (options.proposal.source === "codex" || options.proposal.source === "comfyui")
      && options.proposal.workflowOptions && Object.values(options.proposal.workflowOptions).some(Boolean);
    const preparationUntil = hasWorkflowChoices ? Date.now() + 20_000 : options.proposal.animaEnabled ? Date.now() + 30_000 : undefined;
    const referencePrepareUntil = options.proposal.referenceImages?.length ? preparationUntil ?? Date.now() + 8_000 : undefined;
    await db.insert(generationJobs).values({ userId: options.userId, kind: "image", templateId: TEMPLATE,
      provider: options.proposal.source, requestKey: `studio:${hash}`, costMushies: 0, refundAmount: 0,
      params: { ...options, conversationId: run.conversationId ?? options.runId, requestId: hash, retryCount: 0, assetStatus: "queued", notifyAgent: true,
        ...(preparationUntil ? { preparationUntil, notBefore: preparationUntil } : {}),
        ...(referencePrepareUntil ? { referencePrepareUntil, notBefore: referencePrepareUntil } : {}) }, status: "queued" }).onConflictDoNothing();
    const [job] = await db.select().from(generationJobs).where(and(eq(generationJobs.userId, options.userId), eq(generationJobs.requestKey, `studio:${hash}`)));
    if (!job || job.templateId !== TEMPLATE) throw new Error("The image job could not be queued.");
    return describe(job);
  };
  const execute = async (job: Job, controller: AbortController) => {
    const params = job.params as unknown as Options & { requestId: string; retryCount?: number };
    try {
      controller.signal.throwIfAborted();
      const referenceGuidance = params.proposal.contentRating === "nsfw"
        ? [params.proposal.styleInstructions ? `\n\nProject visual style:\n${params.proposal.styleInstructions}` : "",
          params.proposal.outfitInstructions ? `\n\nExact outfit clothing guidance:\n${params.proposal.outfitInstructions.slice(0, 3000)}` : ""].join("")
        : params.proposal.referenceImages?.length || params.proposal.styleInstructions || params.proposal.outfitInstructions
        ? `\n\n${studioImageReferenceGuidance(params.proposal.referenceImages ?? [], params.proposal.styleInstructions, params.proposal.outfitInstructions)}` : "";
      let lastProgressWrite = 0;
      const progress = (value: { phase: string; percent?: number }) => {
        const now = Date.now();
        if (now - lastProgressWrite < 900 && value.phase !== "saving") return;
        lastProgressWrite = now;
        void db.update(generationJobs).set({ params: { ...job.params, progressPhase: value.phase,
          ...(typeof value.percent === "number" ? { progressPercent: value.percent } : {}) } })
          .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "running"))).catch(() => {});
      };
      const image = await generate(job.userId, { provider: params.proposal.source, prompt: `${params.proposal.prompt}${referenceGuidance}`,
        requestId: params.requestId, imageKind: params.proposal.imageKind ?? "sprite", worldId: params.worldId, referenceImages: params.proposal.referenceImages,
        imageWorkflow: params.proposal.imageWorkflow, contentRating: params.proposal.contentRating ?? "sfw", transparent: params.proposal.transparent === true,
        seedMode: params.proposal.seedMode ?? "random", ...(params.proposal.seedMode === "fixed" && params.proposal.seed !== undefined ? { seed: params.proposal.seed } : {}),
        cfg: params.proposal.cfg ?? 1, steps: params.proposal.steps ?? 8,
        ...(params.proposal.animaEnabled ? { animaModel: params.proposal.animaModel } : {}),
        progress, signal: controller.signal });
      const reviewRequired = image.source.reviewRequired === true;
      const assetStatus = reviewRequired ? "review_required" : "generated";
      const assetReason = reviewRequired ? (image.source.reviewReasons ?? []).join("; ") || "Transparency quality needs review." : undefined;
      await db.update(generationJobs).set({ status: "succeeded", assetId: image.id, assetIds: [image.id], completedAt: new Date(),
        params: { ...job.params, assetStatus, ...(assetReason ? { assetReason } : {}),
          ...(image.source.reviewRequired ? { reviewRequired: true, reviewReasons: image.source.reviewReasons ?? [] } : {}),
          progressPhase: "complete", progressPercent: 100 } })
        .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "running")));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code)
        : error instanceof Error && error.message.includes("NSFW") ? "NSFW_IMAGE_REQUEST"
          : controller.signal.aborted ? "SERVER_RESTART" : "GENERATION_FAILED";
      // These Codex admission gates occur before any provider submission. Keep
      // waiting jobs durable instead of failing a fan-out when slots are full.
      const retryCount = Number((job.params as Record<string, unknown>).retryCount ?? 0);
      if (!controller.signal.aborted && job.provider === "codex" && ["GENERATION_BUSY", "RATE_LIMITED"].includes(code) && retryCount < 2) {
        await db.update(generationJobs).set({ status: "queued", startedAt: null, errorCode: null, errorMessage: null,
          params: { ...job.params, retryCount: retryCount + 1, notBefore: Date.now() + (code === "RATE_LIMITED" ? 60_000 : 5_000) } })
          .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "running")));
        return;
      }
      await db.update(generationJobs).set({ status: "failed", errorCode: code,
        errorMessage: code === "NSFW_IMAGE_REQUEST" ? "The selected workflow could not clear this request. No image was generated."
          : error instanceof Error ? error.message.slice(0, 500) : code,
        params: { ...job.params, assetStatus: "failed", assetReason: code },
        completedAt: new Date() }).where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "running")));
    } finally {
      void studioImageNotifications.notify(job.userId, params.worldId, params.runId)
        .catch(error => console.warn("[Studio image notification] Dispatch failed", error instanceof Error ? error.name : "Error"));
    }
  };
  const tick = async () => {
    if (ticking || stopped || active.size >= 4) return;
    ticking = true;
    try {
      const queued = await db.select().from(generationJobs).where(and(eq(generationJobs.templateId, TEMPLATE),
        inArray(generationJobs.provider, ["codex", "comfyui", "forgeneo"]), eq(generationJobs.status, "queued")))
        .orderBy(asc(generationJobs.createdAt)).limit(64);
      for (const job of queued) {
        if (stopped || active.size >= 4) break;
        if (typeof job.params.notBefore === "number" && job.params.notBefore > Date.now()) continue;
        if ([...active.values()].filter(value => value.userId === job.userId).length >= 4) continue;
        // Native Codex images have independent sessions. Local GPU workflow
        // providers retain one active job per creator.
        if (job.provider === "comfyui" && [...active.values()].some(value => value.provider === "comfyui")) continue;
        if (job.provider !== "codex" && [...active.values()].some(value => value.userId === job.userId && value.provider !== "codex")) continue;
        const controller = new AbortController();
        let finish!: () => void;
        const promise = new Promise<void>(resolve => { finish = resolve; });
        active.set(job.id, { userId: job.userId, provider: job.provider, controller, promise });
        try {
          const [claimed] = await db.update(generationJobs).set({ status: "running", startedAt: new Date() })
            .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "queued"))).returning();
          if (!claimed) { active.delete(job.id);finish();continue; }
          if (stopped) controller.abort(new Error("Server restarting"));
          void execute(claimed, controller).catch(error => console.warn("[Studio image job] Could not persist result", error instanceof Error ? error.name : "Error"))
            .finally(() => { active.delete(job.id);finish(); });
        } catch (error) { active.delete(job.id);finish();throw error; }
      }
    } finally { ticking = false; }
  };
  const list = async (userId: string, worldId: string, conversationId: string, runId?: string) => {
    const jobs = await db.select().from(generationJobs).where(and(eq(generationJobs.userId, userId), eq(generationJobs.templateId, TEMPLATE),
      sql`${generationJobs.params}->>'worldId' = ${worldId}`, sql`${generationJobs.params}->>'conversationId' = ${conversationId}`,
      runId ? sql`${generationJobs.params}->>'runId' = ${runId}` : undefined))
      .orderBy(desc(generationJobs.createdAt)).limit(runId ? 100 : 16);
    const taskSummary = jobs.reduce((summary, job) => {
      const params = job.params as unknown as Options & { assetStatus?: string };
      summary.total++;
      if (job.status === "queued") summary.queued++;
      if (job.status === "running") summary.running++;
      if (job.status === "failed" || job.status === "cancelled") summary.failed++;
      if (job.status === "succeeded") summary.completed++;
      if (params.assetStatus === "assigned" || params.assetStatus === "verified") summary.assigned++;
      if (params.assetStatus === "verified") summary.verified++;
      if (params.assetStatus === "unassigned") summary.unassigned++;
      return summary;
    }, { total: 0, queued: 0, running: 0, failed: 0, completed: 0, assigned: 0, verified: 0, unassigned: 0 });
    const task = { ...taskSummary, phase: taskSummary.running ? "execute" : taskSummary.queued ? "prepare"
      : taskSummary.completed > taskSummary.assigned + taskSummary.unassigned ? "integrate" : taskSummary.completed ? "verify" : "complete" };
    const taskPreflight = jobs.map(job => (job.params as Record<string, unknown>).taskPreflight).find(value => value !== undefined);
    return jobs.map(job => {
      const params = job.params as unknown as Options;
      const status = describe(job);
      return { ...status, purpose: params.proposal.purpose, card: { ...params.proposal, runId: params.runId,
        toolCallId: params.callId, jobId: job.id, textContent: "", unitMushies: 0, estimatedMushies: 0,
        elapsed: status.elapsed, assetIds: status.assetIds, errorCode: status.errorCode, error: status.errorMessage ?? status.errorCode, jobStatus: job.status,
        referenceEditable: status.referenceEditable, referencePrepareUntil: status.referencePrepareUntil,
        animaEnabled: status.animaEnabled, animaModel: status.animaModel, animaModelEditable: status.animaModelEditable,
        imageWorkflow: status.imageWorkflow, contentRating: status.contentRating, workflowOptions: status.workflowOptions,
        workflowEditable: status.workflowEditable, generationOptionsEditable: status.generationOptionsEditable,
        seedMode: status.seedMode, seed: status.seed, cfg: status.cfg, steps: status.steps,
        progressPhase: status.progressPhase, progressPercent: status.progressPercent,
        assetStatus: status.assetStatus, assetReason: status.assetReason, taskSummary: task, taskPreflight,
        status: job.status === "succeeded" ? "done" : job.status === "failed" ? "failed" : job.status === "cancelled" ? "cancelled" : "generating" } };
    });
  };
  const removeReference = async (userId: string, jobId: string, worldId: string, key: string) => db.transaction(async tx => {
    const [job] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId),
      eq(generationJobs.templateId, TEMPLATE), sql`${generationJobs.params}->>'worldId' = ${worldId}`)).for("update");
    if (!job) return null;
    const params = job.params as unknown as Options & { referencePrepareUntil?: number };
    if (job.status !== "queued" || !params.referencePrepareUntil || Date.now() > params.referencePrepareUntil) return describe(job);
    const references = params.proposal.referenceImages ?? [];
    if (!references.some(ref => (ref.assetRef ?? ref.key) === key)) return describe(job);
    const nextParams = { ...job.params, proposal: { ...params.proposal,
      referenceImages: references.filter(ref => (ref.assetRef ?? ref.key) !== key) } };
    const [updated] = await tx.update(generationJobs).set({ params: nextParams })
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "queued"))).returning();
    return updated ? describe(updated) : null;
  });
  const setAnimaModel = async (userId: string, jobId: string, worldId: string, model: string, installedModels: readonly string[]) =>
    db.transaction(async tx => {
      const [job] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId),
        eq(generationJobs.templateId, TEMPLATE), sql`${generationJobs.params}->>'worldId' = ${worldId}`)).for("update");
      if (!job) return null;
      const params = job.params as unknown as Options & { preparationUntil?: number };
      if (!canChangeAnimaModel({ status: job.status, animaEnabled: params.proposal.animaEnabled === true,
        preparationUntil: params.preparationUntil })) return describe(job);
      if (!installedModels.includes(model)) return null;
      if (params.proposal.contentRating === "nsfw" && !animaModelSupportsNsfw(model)) return null;
      const nextParams = { ...job.params, proposal: { ...params.proposal, animaModel: model } };
      const [updated] = await tx.update(generationJobs).set({ params: nextParams })
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "queued"))).returning();
      return updated ? describe(updated) : null;
    });
  const updateGenerationOptions = async (userId: string, jobId: string, worldId: string, options: {
    workflow: "anima" | "krea" | "codex"; contentRating: "sfw" | "nsfw"; animaModel?: string;
    seedMode: "random" | "fixed"; seed?: number; cfg: number; steps: number; transparent: boolean;
  }, installedAnimaModels: readonly string[]) => db.transaction(async tx => {
    const [job] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId),
      eq(generationJobs.templateId, TEMPLATE), sql`${generationJobs.params}->>'worldId' = ${worldId}`)).for("update");
    if (!job) return null;
    const params = job.params as unknown as Options & { preparationUntil?: number };
    const proposal = params.proposal;
    if (!canChangeAnimaModel({ status: job.status, animaEnabled: proposal.workflowOptions !== undefined || proposal.animaEnabled === true,
      preparationUntil: params.preparationUntil })) return describe(job);
    if (!proposal.workflowOptions?.[options.workflow] || (options.seedMode === "fixed" && options.seed === undefined)
      || (options.workflow === "krea" && options.contentRating !== "nsfw" && (proposal.referenceImages?.length ?? 0) > 4)) return null;
    const model = options.workflow === "anima" ? options.animaModel ?? proposal.animaModel : undefined;
    if (options.workflow === "anima" && (!model || !installedAnimaModels.includes(model))) return null;
    const nsfwCapable = options.workflow === "krea" || (options.workflow === "anima" && !!model && animaModelSupportsNsfw(model));
    if (options.contentRating === "nsfw" && !nsfwCapable) return null;
    const nextProposal: ImageProposal = { ...proposal, source: options.workflow === "codex" ? "codex" : "comfyui",
      model: options.workflow === "codex" ? CODEX_IMAGE_LABEL : options.workflow === "krea" ? "Krea2-Anime v2.0 INT4 · local" : "ComfyUI",
      imageWorkflow: options.workflow, animaEnabled: options.workflow === "anima", contentRating: options.contentRating,
      transparent: proposal.imageKind === "sprite" && options.transparent, seedMode: options.seedMode,
      ...(options.seedMode === "fixed" ? { seed: options.seed } : { seed: undefined }), cfg: options.cfg, steps: options.steps,
      ...(model ? { animaModel: model } : {}) };
    const [updated] = await tx.update(generationJobs).set({ provider: nextProposal.source, params: { ...job.params, proposal: nextProposal } })
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "queued"))).returning();
    return updated ? describe(updated) : describe(job);
  });
  const cancel = async (userId: string, jobId: string, worldId: string) => {
    return db.transaction(async tx => {
      const [owned] = await tx.select({ id: generationJobs.id }).from(generationJobs)
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), eq(generationJobs.templateId, TEMPLATE),
          sql`${generationJobs.params}->>'worldId' = ${worldId}`));
      if (!owned) return null;
      // Image saves use this same owner lock. Cancellation either stops the
      // pending save or returns the already committed picture, never hides it.
      await sessionMedia.lockOwner(tx, userId);
      const [job] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId),
        eq(generationJobs.templateId, TEMPLATE), sql`${generationJobs.params}->>'worldId' = ${worldId}`)).for("update");
      if (!job) return null;
      if (!["queued", "running"].includes(job.status)) return describe(job);
      const [saved] = await mediaRows<{ id: string }>(tx, sql`SELECT a.id FROM image_generation_requests r
        JOIN user_assets a ON a.id=r.asset_id WHERE r.user_id=${userId} AND r.request_id=${String(job.params.requestId)}
        AND r.state='succeeded' AND a.user_id=${userId} AND a.type='image'`);
      const [updated] = await tx.update(generationJobs).set(saved
        ? { status: "succeeded", assetId: saved.id, assetIds: [saved.id], completedAt: new Date(), params: { ...job.params, assetStatus: "generated" } }
        : { status: "cancelled", completedAt: new Date(), errorCode: "USER_CANCELLED", params: { ...job.params, assetStatus: "cancelled" } }).where(eq(generationJobs.id, jobId)).returning();
      if (!saved) active.get(jobId)?.controller.abort(new Error("Image generation cancelled by creator"));
      return describe(updated!);
    });
  };
  const recover = async () => {
    const stranded = await db.select().from(generationJobs).where(and(eq(generationJobs.templateId, TEMPLATE),
      inArray(generationJobs.provider, ["codex", "comfyui", "forgeneo"]), eq(generationJobs.status, "running")));
    for (const job of stranded) {
      const hash = String(job.params.requestId ?? "");
      const saved = hash ? await generatedImageStorage.findRequest?.(job.userId, hash, new AbortController().signal) : undefined;
      if (!saved && hash) await generatedImageStorage.failRequest?.(job.userId, hash);
      await db.update(generationJobs).set(saved ? { status: "succeeded", assetId: saved.id, assetIds: [saved.id], completedAt: new Date(), params: { ...job.params, assetStatus: "generated" } }
        : { status: "failed", errorCode: "SERVER_RESTART", errorMessage: "Generation interrupted by server restart. No automatic retry.", params: { ...job.params, assetStatus: "failed", assetReason: "SERVER_RESTART" }, completedAt: new Date() })
        .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "running")));
    }
    const undelivered = await db.select().from(generationJobs).where(and(eq(generationJobs.templateId, TEMPLATE),
      inArray(generationJobs.status, ["succeeded", "failed"]), sql`${generationJobs.params}->>'notifyAgent' = 'true'`,
      sql`${generationJobs.params}->>'notificationRunId' IS NULL`, sql`${generationJobs.params}->>'notificationSkipped' IS NULL`));
    for (const job of undelivered) {
      const params = job.params as unknown as Options;
      await studioImageNotifications.notify(job.userId, params.worldId, params.runId);
    }
  };
  return { submit, get, list, cancel, removeReference, setAnimaModel, updateGenerationOptions, tick, recover,
    start() {
      if (interval) return;
      stopped = false;
      const serviceTick = () => { void tick().catch(() => {}); void integrateReadyStudioImageTasks().catch(() => {}); };
      void recover().then(() => { if (!stopped) { serviceTick();interval = setInterval(serviceTick, 1000);interval.unref(); } })
        .catch(error => console.warn("[Studio image jobs] Recovery unavailable", error instanceof Error ? error.name : "Error"));
    },
    stop() { stopped = true;if (interval) clearInterval(interval);interval = undefined; },
    async drain(timeoutMs: number) {
      if (!active.size) return;
      let timer: ReturnType<typeof setTimeout>;
      const finished = await Promise.race([Promise.all([...active.values()].map(value => value.promise)).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      clearTimeout(timer!);
      if (!finished) for (const value of active.values()) value.controller.abort(new Error("Server restarting"));
    },
  };
}

export const configuredImageJobs = createConfiguredImageJobs();
