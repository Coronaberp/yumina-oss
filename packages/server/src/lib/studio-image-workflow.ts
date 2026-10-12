import { and, eq, inArray, sql } from "drizzle-orm";
import { isVnInterface, migrateWorldDefinition, readVnAssetMap, readVnOpeningScenes, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, generationJobs, worldSnapshots, worlds } from "../db/schema.js";
import { assertOwnedVnImageRef } from "./studio-tools/asset-catalog.js";
import { applyVnAssetOperation } from "./studio-tools/vn-asset-tools.js";
import { getStructuralPreflight } from "./studio-tools/project-intelligence.js";
import { resolveWorkingSchema, writeStudioWorldSchema } from "./pending-edit.js";

const TEMPLATE = "studio-configured-image";
type Target = { kind: string; sceneId?: string; period?: string; openingId?: string; characterId?: string; expression?: string };
type WorkflowParams = { userId: string; worldId: string; runId: string; callId: string;
  proposal: { target?: Target; unassignedReason?: string }; assetStatus?: string; assetReason?: string; taskPreflight?: unknown;
  reviewRequired?: boolean; reviewReasons?: string[] };
type WorkflowJob = typeof generationJobs.$inferSelect;
type Outcome = { assetStatus: "verified" | "unassigned"; assetReason?: string };

function slotOperation(world: WorldDefinition, target: Target, assetRef: string): { operation?: Record<string, unknown>; reason?: string; alreadyAssigned?: boolean } {
  const root = isVnInterface(world.rootComponent) ? world.rootComponent : null;
  if (!root) return { reason: "The current project has no managed VN asset maps." };
  if (target.kind === "background") {
    if (!target.sceneId || !target.period) return { reason: "An exact scene ID and time period are required." };
    const source = root.files["scenes.ts"];
    if (!source) return { reason: "The managed scenes map is missing." };
    try {
      const map = target.openingId ? readVnOpeningScenes(source)[target.openingId] : readVnAssetMap(source, "backgrounds");
      if (target.openingId && !map) return { reason: "The requested opening scene map is unavailable." };
      const value = map?.[target.sceneId];
      const variant = target.period.toLowerCase();
      const existing = typeof value === "string" ? (variant === "day" ? value : undefined) : value?.[variant];
      if (existing) return existing === assetRef ? { alreadyAssigned: true } : { reason: "That scene and time slot was filled while the image was generating." };
      return { operation: { kind: "backgrounds", action: "assign", name: target.sceneId, variant,
        ...(target.openingId ? { openingId: target.openingId } : {}), assetRef } };
    } catch { return { reason: "The current scenes map is not a supported literal map." }; }
  }
  if (target.kind === "sprite") {
    if (!target.characterId || !target.expression) return { reason: "An exact character ID and expression are required." };
    const source = root.files["sprites.ts"];
    if (!source) return { reason: "The managed sprites map is missing." };
    try {
      const map = readVnAssetMap(source, "sprites");
      const value = map[target.characterId];
      const variant = target.expression.toLowerCase();
      const existing = typeof value === "string" ? (variant === "normal" ? value : undefined) : value?.[variant];
      if (existing) return existing === assetRef ? { alreadyAssigned: true } : { reason: "That character expression was filled while the image was generating." };
      return { operation: { kind: "sprites", action: "assign", name: target.characterId, variant, assetRef } };
    } catch { return { reason: "The current sprites map is not a supported literal map." }; }
  }
  if (target.kind === "portrait") {
    if (!target.characterId) return { reason: "An exact character ID is required." };
    const entry = world.entries.find(candidate => candidate.id === target.characterId && candidate.role === "character");
    if (!entry) return { reason: "The requested character no longer exists." };
    if (typeof entry.portrait === "string" && entry.portrait.trim()) return entry.portrait === assetRef
      ? { alreadyAssigned: true } : { reason: "That character's portrait was filled while the image was generating." };
    return { operation: { kind: "portrait", action: "assign", characterId: target.characterId, assetRef } };
  }
  return { reason: "This image has no supported automatic assignment target; it remains in the asset library." };
}

function targetIsVerified(world: WorldDefinition, target: Target, assetRef: string): boolean {
  if (target.kind === "portrait") return world.entries.some(entry => entry.id === target.characterId && entry.role === "character" && entry.portrait === assetRef);
  const root = isVnInterface(world.rootComponent) ? world.rootComponent : null;
  if (!root) return false;
  try {
    if (target.kind === "background") {
      const source = root.files["scenes.ts"];
      if (!source || !target.sceneId || !target.period) return false;
      const map = target.openingId ? readVnOpeningScenes(source)[target.openingId] : readVnAssetMap(source, "backgrounds");
      const value = map?.[target.sceneId];
      return typeof value === "string" ? target.period.toLowerCase() === "day" && value === assetRef
        : value?.[target.period.toLowerCase()] === assetRef;
    }
    if (target.kind === "sprite") {
      const source = root.files["sprites.ts"];
      if (!source || !target.characterId || !target.expression) return false;
      const value = readVnAssetMap(source, "sprites")[target.characterId];
      return typeof value === "string" ? target.expression.toLowerCase() === "normal" && value === assetRef
        : value?.[target.expression.toLowerCase()] === assetRef;
    }
  } catch { return false; }
  return false;
}

async function markJob(job: WorkflowJob, outcome: Outcome, taskPreflight: unknown) {
  await db.update(generationJobs).set({ params: { ...job.params, assetStatus: outcome.assetStatus,
    ...(outcome.assetReason ? { assetReason: outcome.assetReason } : { assetReason: null }), taskPreflight,
    integrationCompletedAt: new Date().toISOString() } })
    .where(and(eq(generationJobs.id, job.id), eq(generationJobs.templateId, TEMPLATE)));
}

/** Integrate all exact, still-empty image targets from one settled agent run in one reversible save. */
export async function integrateCompletedStudioImageTask(userId: string, worldId: string, taskId: string) {
  const jobs = await db.select().from(generationJobs).where(and(eq(generationJobs.userId, userId), eq(generationJobs.templateId, TEMPLATE),
    sql`${generationJobs.params}->>'worldId' = ${worldId}`, sql`${generationJobs.params}->>'runId' = ${taskId}`));
  if (!jobs.length || jobs.some(job => !["succeeded", "failed", "cancelled"].includes(job.status))) return null;
  const pending = jobs.filter(job => !((job.params as unknown as WorkflowParams & { integrationCompletedAt?: string }).integrationCompletedAt));
  if (!pending.length) return null;
  const [ownedWorld] = await db.select({ schema: worlds.schema, status: worlds.status, isPublished: worlds.isPublished, creatorId: worlds.creatorId })
    .from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
  if (!ownedWorld) return null;
  const status = ownedWorld.status ?? (ownedWorld.isPublished ? "published" : "draft");
  const workingSchema = await resolveWorkingSchema(worldId, status, ownedWorld.schema as Record<string, unknown>);
  // Keep the optimistic-lock baseline separate: current-schema migrations may
  // return the input object, and VN asset operations mutate that object.
  const expectedSchema = structuredClone(workingSchema);
  let world = migrateWorldDefinition(structuredClone(workingSchema) as unknown as WorldDefinition);
  const before = structuredClone(world) as WorldDefinition;
  const outcomes = new Map<string, Outcome>();
  const assignments: Array<{ job: WorkflowJob; target: Target; assetRef: string }> = [];

  for (const job of pending) {
    const params = job.params as unknown as WorkflowParams;
    if (job.status !== "succeeded") {
      outcomes.set(job.id, { assetStatus: job.status === "cancelled" ? "unassigned" : "unassigned", assetReason: job.errorCode ?? job.status });
      continue;
    }
    if (params.reviewRequired) {
      outcomes.set(job.id, { assetStatus: "unassigned", assetReason: `Saved for review; automatic assignment paused. ${params.reviewReasons?.join("; ") || "Transparency quality checks were inconclusive."}` });
      continue;
    }
    const target = params.proposal?.target;
    const assetId = job.assetIds?.[0] ?? job.assetId;
    if (!assetId) { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: "The image completed without a saved asset." }); continue; }
    if (!target || params.proposal.unassignedReason) {
      outcomes.set(job.id, { assetStatus: "unassigned", assetReason: params.proposal.unassignedReason ?? "No exact asset target was selected; the image remains in the library." });
      continue;
    }
    const ref = `@asset:${assetId}`;
    try { await assertOwnedVnImageRef(userId, worldId, ref); }
    catch { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: "The generated asset is no longer available to this project." }); continue; }
    if (target.kind === "portrait") {
      const state = slotOperation(world, target, ref);
      if (state.reason) { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: state.reason }); continue; }
      if (state.alreadyAssigned) { outcomes.set(job.id, { assetStatus: "verified" }); continue; }
      const entry = world.entries.find(candidate => candidate.id === target.characterId && candidate.role === "character");
      if (!entry) { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: "The requested character no longer exists." }); continue; }
      entry.portrait = ref;
      assignments.push({ job, target, assetRef: ref });
      continue;
    }
    const state = slotOperation(world, target, ref);
    if (state.reason) { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: state.reason }); continue; }
    if (state.alreadyAssigned) { outcomes.set(job.id, { assetStatus: "verified" }); continue; }
    if (!state.operation) { outcomes.set(job.id, { assetStatus: "unassigned", assetReason: "This asset target could not be applied." }); continue; }
    try {
      applyVnAssetOperation(world, state.operation);
      assignments.push({ job, target, assetRef: ref });
    } catch (error) {
      outcomes.set(job.id, { assetStatus: "unassigned", assetReason: error instanceof Error ? error.message.slice(0, 300) : "The managed asset assignment failed." });
    }
  }

  let saveError: string | undefined;
  if (assignments.length) {
    try {
      await db.transaction(async tx => {
        await tx.insert(worldSnapshots).values({ worldId, userId, agentRunId: taskId,
          schemaData: before as unknown as Record<string, unknown>, label: "Before generated asset batch" });
        await tx.update(agentRuns).set({ context: sql`COALESCE(${agentRuns.context}, '{}'::jsonb) || '{"studioAppliedChanges":true}'::jsonb` })
          .where(and(eq(agentRuns.id, taskId), eq(agentRuns.userId, userId), eq(agentRuns.worldId, worldId)));
        await writeStudioWorldSchema({ worldId, creatorId: userId, schema: world as unknown as Record<string, unknown>,
          expectedSchema, database: tx });
      });
      const [persistedWorld] = await db.select({ schema: worlds.schema }).from(worlds)
        .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
      if (!persistedWorld) throw new Error("The project is no longer available after the image assignment.");
      const reread = await resolveWorkingSchema(worldId, status, persistedWorld.schema as Record<string, unknown>);
      world = migrateWorldDefinition(structuredClone(reread) as unknown as WorldDefinition);
      for (const assignment of assignments) outcomes.set(assignment.job.id, targetIsVerified(world, assignment.target, assignment.assetRef)
        ? { assetStatus: "verified" }
        : { assetStatus: "unassigned", assetReason: "Saved image assignment did not verify in the current project." });
    } catch (error) {
      saveError = error instanceof Error ? error.message.slice(0, 300) : "The image assignments could not be saved.";
      for (const assignment of assignments) outcomes.set(assignment.job.id, { assetStatus: "unassigned", assetReason: saveError });
    }
  }

  let schemaReadError: string | undefined;
  try {
    const currentSchema = await resolveWorkingSchema(worldId, status, ownedWorld.schema as Record<string, unknown>);
    world = migrateWorldDefinition(currentSchema as unknown as WorldDefinition);
  } catch (error) {
    world = before;
    schemaReadError = error instanceof Error ? error.message.slice(0, 300) : "The current project could not be read for preflight.";
  }
  let compactPreflight: { clean: boolean; analysisComplete: boolean; errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> };
  try {
    const preflight = getStructuralPreflight(world);
    compactPreflight = { clean: preflight.clean, analysisComplete: preflight.analysisComplete,
      errors: preflight.blockingErrors.map(item => ({ code: item.code, message: item.message })).slice(0, 20),
      warnings: preflight.warnings.map(item => ({ code: item.code, message: item.message })).slice(0, 30) };
  } catch (error) {
    compactPreflight = { clean: false, analysisComplete: false,
      errors: [{ code: "PREFLIGHT_FAILED", message: error instanceof Error ? error.message.slice(0, 300) : "The project preflight could not be completed." }], warnings: [] };
  }
  if (schemaReadError) compactPreflight = { ...compactPreflight, clean: false, analysisComplete: false,
    errors: [...compactPreflight.errors, { code: "PROJECT_READ_FAILED", message: schemaReadError }].slice(0, 20) };
  for (const job of pending) await markJob(job, outcomes.get(job.id) ?? { assetStatus: "unassigned", assetReason: saveError ?? "Image target was not applied." }, compactPreflight);
  return { taskId, total: jobs.length, assigned: [...outcomes.values()].filter(value => value.assetStatus === "verified").length,
    unassigned: [...outcomes.values()].filter(value => value.assetStatus === "unassigned").length, preflight: compactPreflight };
}

/** Find closed agent runs whose durable image children all settled. */
export async function integrateReadyStudioImageTasks(limit = 12) {
  const candidates = await db.select().from(generationJobs).where(and(eq(generationJobs.templateId, TEMPLATE),
    inArray(generationJobs.status, ["succeeded", "failed", "cancelled"]))).orderBy(sql`${generationJobs.completedAt} DESC`).limit(500);
  const groups = new Map<string, { userId: string; worldId: string; runId: string }>();
  for (const job of candidates) {
    const params = job.params as unknown as WorkflowParams;
    if (params.runId && params.worldId) groups.set(params.runId, { userId: job.userId, worldId: params.worldId, runId: params.runId });
  }
  let processed = 0;
  for (const task of groups.values()) {
    if (processed >= limit) break;
    const [run] = await db.select({ status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.id, task.runId), eq(agentRuns.userId, task.userId), eq(agentRuns.worldId, task.worldId)));
    if (!run || run.status === "running" || run.status === "awaiting_credits") continue;
    try { if (await integrateCompletedStudioImageTask(task.userId, task.worldId, task.runId)) processed++; }
    catch (error) { console.warn("[Studio image workflow] Could not integrate task", error instanceof Error ? error.name : "Error"); }
  }
  return processed;
}
