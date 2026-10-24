import { Hono } from "hono";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { migrateWorldDefinition } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { worlds, studioConversations, worldSnapshots, agentRuns } from "../db/schema.js";
import { diffStudioSnapshotMaterials, summarizeSnapshotTimeline } from "../lib/studio-tools/snapshot-summary.js";
import { decodeStudioSnapshotMaterial, encodeStudioSnapshotMaterial } from "../lib/studio-world-material.js";
import { captureStudioCreditWorldRevision } from "../lib/studio-credit-checkpoint.js";
import { isDeepStrictEqual } from "node:util";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { readTemplateContent, readTemplateMeta } from "../lib/studio-tools/index.js";
import { getTemplateCatalogSummary } from "../lib/studio-skills/index.js";
import { isS3Configured, generateUploadUrl, getObjectBuffer } from "../lib/s3.js";
import { imageMasters, ImageMasterError, isImageMasterKey, validSourceSha256 } from "../lib/image-masters.js";
import { normalizeImportedImage, ImageImportPolicyError } from "../lib/image-import.js";
import { validUploadRequestId } from "../lib/asset-upload-operation.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import {
  deleteStudioConversationForWorld,
  loadStudioConversationForDisplay,
  updateStudioConversationForWorld,
} from "../lib/studio-conversations.js";
import { resolveWorkingSchema, writeStudioWorldSchema } from "../lib/pending-edit.js";
import { inspectOwnedVnImageRefs } from "../lib/studio-tools/asset-catalog.js";
import { getStructuralPreflight } from "../lib/studio-tools/project-intelligence.js";

const studioRoutes = new Hono<AppEnv>();

studioRoutes.use("/*", authMiddleware);

// Auto-backup written before each rollback so the rollback itself is reversible.
// Only the most recent one is kept — older backups are pruned at rollback time.
const BEFORE_ROLLBACK_LABEL = "Before rollback";

// POST /api/studio/upload-url — get presigned URL for studio chat file attachment
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
type StudioImageUpload = { filename: string; contentType: string; fileSize: number; sourceSha256?: string; requestId?: string };

function validStudioImageUpload(value: unknown): value is StudioImageUpload {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.filename === "string" && body.filename.trim().length > 0 && body.filename.length <= 1024 &&
    typeof body.contentType === "string" && ALLOWED_IMAGE_TYPES.includes(body.contentType) &&
    Number.isSafeInteger(body.fileSize) && Number(body.fileSize) > 0 && Number(body.fileSize) <= MAX_FILE_SIZE &&
    validSourceSha256(body.sourceSha256) && validUploadRequestId(body.requestId);
}
function ownedStudioMaster(userId: string, key: unknown): key is string {
  return typeof key === "string" && key.startsWith(`users/${userId}/image-masters/public/`) && isImageMasterKey(key);
}
function ownedLegacyStudioKey(userId: string, key: unknown): key is string {
  const prefix = `studio-chat/${userId}/`;
  return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length &&
    !/[\\\x00-\x1f\x7f]/.test(key) && !key.split("/").some(part => part === "." || part === "..");
}

studioRoutes.post("/upload-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "File storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const body: unknown = await c.req.json().catch(() => null);
  if (!validStudioImageUpload(body)) return c.json({ error: "Upload a PNG, JPEG, WebP or GIF image of at most 10 MB with valid upload details." }, 400);
  if (body.sourceSha256) {
    const master = await imageMasters.find(currentUser.id, "public", body.sourceSha256);
    if (master) {
      if (master.originalSize !== body.fileSize || master.mimeType !== body.contentType) return c.json({ error: "Image details do not match the verified original." }, 409);
      return c.json({ data: { key: master.key, reused: true } });
    }
  }
  const ext = body.contentType === "image/jpeg" ? "jpg" : body.contentType.slice(6);
  const key = `studio-chat/${currentUser.id}/${body.requestId ?? crypto.randomUUID()}.${ext}`;

  const uploadUrl = await generateUploadUrl(key, body.contentType, { contentLength: body.fileSize, expiresIn: 600 });

  return c.json({
    data: {
      uploadUrl,
      key,
    },
  });
});

// A completed PUT is still untrusted. Confirm original bytes before attaching.
studioRoutes.post("/upload-confirm", async (c) => {
  if (!isS3Configured()) return c.json({ error: "File storage not configured" }, 503);
  const userId = c.get("user").id;
  const body: unknown = await c.req.json().catch(() => null);
  if (!validStudioImageUpload(body)) return c.json({ error: "Invalid image upload details." }, 400);
  const key = (body as StudioImageUpload & { key?: unknown }).key;
  if (typeof key !== "string") return c.json({ error: "Invalid asset key" }, 403);
  const canonical = ownedStudioMaster(userId, key);
  if (!canonical && !ownedLegacyStudioKey(userId, key)) return c.json({ error: "Invalid asset key" }, 403);
  try {
    const existing = canonical ? await imageMasters.findByKey(userId, "public", key)
      : await imageMasters.findUpload(userId, "public", key);
    if (canonical && !existing) return c.json({ error: "Invalid asset key" }, 403);
    if (existing && (existing.originalSize !== body.fileSize || existing.mimeType !== body.contentType ||
      body.sourceSha256 && existing.sourceSha256 !== body.sourceSha256.toLowerCase())) return c.json({ error: "Image details do not match the verified original." }, 409);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const source = await getObjectBuffer(existing?.key ?? key, { maxBytes: MAX_FILE_SIZE, signal });
    if (source.buffer.length !== body.fileSize) return c.json({ error: "Image size does not match the upload." }, 409);
    let image;
    try { image = await normalizeImportedImage(source.buffer); }
    catch (error) {
      if (error instanceof ImageImportPolicyError) return c.json({ error: "Animated PNG attachments are not supported in Studio. Use an animated GIF or WebP instead, and keep the original in your asset library." }, 400);
      return c.json({ error: "The uploaded file is not a valid supported image." }, 400);
    }
    signal.throwIfAborted();
    if (image.mimeType !== body.contentType || source.contentType !== body.contentType) return c.json({ error: "Image content type does not match the upload." }, 409);
    const master = await imageMasters.store({ userId, access: "public", bytes: image.bytes, mimeType: image.mimeType,
      sourceSha256: existing?.sourceSha256 ?? body.sourceSha256, signal });
    if (!canonical) await imageMasters.rememberUpload(userId, "public", key, master.sourceSha256);
    return c.json({ data: { key: master.key, url: resolveImageCdn(master.key) ?? master.key, mimeType: master.mimeType, name: body.filename } });
  } catch (error) {
    if (error instanceof ImageMasterError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Image verification failed. Please try again." }, 503);
  }
});

// POST /api/studio/download-url — get presigned download URL for a studio chat attachment
studioRoutes.post("/download-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "File storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const body = await c.req.json<{ key?: unknown }>();

  // Legacy attachments remain readable. New masters require an exact owner row.
  if (!ownedLegacyStudioKey(currentUser.id, body.key) &&
    !(ownedStudioMaster(currentUser.id, body.key) && await imageMasters.findByKey(currentUser.id, "public", body.key))) {
    return c.json({ error: "Invalid asset key" }, 403);
  }

  const url = resolveImageCdn(body.key as string) ?? body.key;

  return c.json({ data: { url } });
});

// GET /api/studio/:worldId/preflight — validate the creator's current working copy before play/export.
studioRoutes.get("/:worldId/preflight", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const [row] = await db.select({ schema: worlds.schema, status: worlds.status, isPublished: worlds.isPublished })
    .from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))).limit(1);
  if (!row) return c.json({ error: "World not found or not authorized" }, 404);

  const workingSchema = await resolveWorkingSchema(worldId, row.status ?? (row.isPublished ? "published" : "draft"), row.schema as Record<string, unknown>);
  const world = migrateWorldDefinition(workingSchema as unknown as WorldDefinition);
  const report = getStructuralPreflight(world);
  let missingAssets: Awaited<ReturnType<typeof inspectOwnedVnImageRefs>>;
  try {
    missingAssets = await inspectOwnedVnImageRefs(currentUser.id, worldId, report.assetRefs);
  } catch {
    return c.json({ code: "ASSET_CHECK_UNAVAILABLE", error: "Image checks are temporarily unavailable. Please try again in a moment." }, 503);
  }
  const blockingErrors = [...report.blockingErrors, ...missingAssets.map(({ ref, reason }) => ({
    severity: "error" as const, code: "missing-image-asset", entityId: ref, evidence: ref,
    message: `Image reference ${ref} is unavailable: ${reason}`,
    fix: "Use an owned image @asset reference from this card or your asset library.",
  }))];
  return c.json({ data: { ...report, clean: blockingErrors.length === 0, blockingErrors, warnings: report.warnings } });
});

// NOTE: /api/studio/playtest (lightweight LLM proxy for ephemeral playtest) was
// deleted when Studio playtest was unified with the real-play pipeline. Playtest
// now creates a real session (with name=__playtest__ sentinel to hide it from
// the session list) and uses /api/messages exactly like a normal chat — this
// eliminates the drift that caused missing BGM / persona / audio-effects in
// playtest. See packages/app/src/features/studio/panels/playtest-panel.tsx.

// ── Template API ──

// GET /api/studio/templates — List all available templates
studioRoutes.get("/templates/list", async (c) => {
  const summary = getTemplateCatalogSummary();
  return c.json({ data: { summary } });
});

// GET /api/studio/templates/:id — Get template metadata + content
studioRoutes.get("/templates/:templateId", async (c) => {
  const templateId = c.req.param("templateId");

  const meta = readTemplateMeta(templateId);
  if (!meta) {
    return c.json({ error: `Template not found: ${templateId}` }, 404);
  }

  const content = readTemplateContent(templateId);

  return c.json({
    data: {
      id: templateId,
      meta,
      content,
    },
  });
});

// ── Conversation Persistence ──

// GET /api/studio/:worldId/conversations — List conversations
studioRoutes.get("/:worldId/conversations", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  const rows = await db
    .select({
      id: studioConversations.id,
      title: studioConversations.title,
      createdAt: studioConversations.createdAt,
      updatedAt: studioConversations.updatedAt,
    })
    .from(studioConversations)
    .where(
      and(
        eq(studioConversations.worldId, worldId),
        eq(studioConversations.userId, currentUser.id)
      )
    )
    .orderBy(desc(studioConversations.updatedAt));

  return c.json({ data: rows });
});

// POST /api/studio/:worldId/conversations — Create a new conversation
studioRoutes.post("/:worldId/conversations", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));

  const [row] = await db
    .insert(studioConversations)
    .values({
      worldId,
      userId: currentUser.id,
      title: (body as { title?: string }).title ?? "New Conversation",
      messages: [],
    })
    .returning();

  return c.json({ data: row });
});

// GET /api/studio/:worldId/conversations/:id — Get a conversation with messages
studioRoutes.get("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");

  const conversation = await loadStudioConversationForDisplay({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
  });

  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ data: conversation });
});

// PATCH /api/studio/:worldId/conversations/:id — Update (save messages)
studioRoutes.patch("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");
  const body = await c.req.json<{
    title?: string;
    messages?: Array<Record<string, unknown>>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.messages !== undefined) updates.messages = body.messages;

  const patched = await updateStudioConversationForWorld({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
    updates,
  });

  if (!patched) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ ok: true });
});

// DELETE /api/studio/:worldId/conversations/:id — Delete a conversation
studioRoutes.delete("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");

  const deleted = await deleteStudioConversationForWorld({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
  });

  if (!deleted) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ ok: true });
});

// ── World Snapshots (revert support) ──

// GET /api/studio/:worldId/snapshots — list recent snapshots
studioRoutes.get("/:worldId/snapshots", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  // Verify ownership
  const worldRows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Optional filter: ?agentRunId=xxx returns the earliest snapshot for that run (for undo)
  const filterRunId = c.req.query("agentRunId");
  const includeSchema = c.req.query("includeSchema") === "true" && !!filterRunId;
  if (filterRunId) {
    const [run] = await db.select({ context: agentRuns.context }).from(agentRuns)
      .where(and(eq(agentRuns.id, filterRunId), eq(agentRuns.worldId, worldId), eq(agentRuns.userId, currentUser.id))).limit(1);
    if (run?.context?.studioAppliedChanges !== true) return c.json({ data: [] });
  }
  const conditions = [eq(worldSnapshots.worldId, worldId)];
  if (filterRunId) conditions.push(eq(worldSnapshots.agentRunId, filterRunId));

  const snapshots = await db
    .select({
      id: worldSnapshots.id,
      label: worldSnapshots.label,
      agentRunId: worldSnapshots.agentRunId,
      createdAt: worldSnapshots.createdAt,
      ...(includeSchema ? { schemaData: worldSnapshots.schemaData } : {}),
    })
    .from(worldSnapshots)
    .where(and(...conditions))
    .orderBy(filterRunId ? asc(worldSnapshots.createdAt) : desc(worldSnapshots.createdAt), asc(worldSnapshots.id))
    .limit(filterRunId ? 1 : 20);

  // Attach per-row change summaries for the dialog timeline (unfiltered list
  // only). The agentRunId-filtered query powers the undo path and stays bare.
  if (!filterRunId && snapshots.length > 0) {
    const ids = snapshots.map((s) => s.id);
    const withSchema = await db
      .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData })
      .from(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), inArray(worldSnapshots.id, ids)))
      .orderBy(asc(worldSnapshots.createdAt), asc(worldSnapshots.id)); // oldest -> newest, id tiebreak
    const current = await captureStudioCreditWorldRevision({ worldId, userId: currentUser.id });
    const summaries = summarizeSnapshotTimeline(
      withSchema.map((s) => ({ id: s.id, schemaData: s.schemaData })),
      encodeStudioSnapshotMaterial(current.schema, current.thumbnailUrl),
    );
    const byId = new Map(summaries.map((s) => [s.id, s.summary]));
    return c.json({ data: snapshots.map((s) => ({ ...s, summary: byId.get(s.id) ?? [] })) });
  }

  return c.json({ data: snapshots.map((snapshot) => {
    if (!snapshot.schemaData) return snapshot;
    const material = decodeStudioSnapshotMaterial(snapshot.schemaData);
    return { ...snapshot, schemaData: material.schema,
      ...(material.thumbnailUrl !== undefined ? { thumbnailUrl: material.thumbnailUrl } : {}) };
  }) });
});

// POST /api/studio/:worldId/rollback/:snapshotId — restore a snapshot
studioRoutes.post("/:worldId/rollback/:snapshotId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");

  // Verify ownership
  const worldRows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Load snapshot
  const snapRows = await db
    .select({ schemaData: worldSnapshots.schemaData })
    .from(worldSnapshots)
    .where(
      and(
        eq(worldSnapshots.id, snapshotId),
        eq(worldSnapshots.worldId, worldId),
      )
    );
  if (snapRows.length === 0) return c.json({ error: "Snapshot not found" }, 404);

  // Capture the creator's CURRENT working state before rollback (including a
  // held published-world draft) so this restore remains reversible.
  const current = await captureStudioCreditWorldRevision({ worldId, userId: currentUser.id });
  const target = decodeStudioSnapshotMaterial(snapRows[0]!.schemaData);
  const rollbackChangesWorkingCopy = !isDeepStrictEqual(current.schema, target.schema)
    || (target.thumbnailUrl !== undefined && target.thumbnailUrl !== current.thumbnailUrl);

  // Apply the rollback through the SAME material-edit gate as a manual/Studio
  // save: on a PUBLISHED world a material rollback (entries/frontend) is parked
  // in world_pending_edits and re-reviewed — it does NOT silently go live —
  // while a non-material rollback (or any non-published world) writes through.
  // This closes the bypass where a rollback rewrote published content unreviewed.
  const { held, reasons } = await writeStudioWorldSchema({
    worldId,
    creatorId: currentUser.id,
    schema: target.schema,
    ...(target.thumbnailUrl !== undefined ? { thumbnailUrl: target.thumbnailUrl } : {}),
    expectedSchema: current.schema,
    expectedThumbnailUrl: current.thumbnailUrl,
  });

  // Replace the prior auto-backup only when the working copy changed. On a
  // published card, the backup is the held draft rather than the live schema.
  if (rollbackChangesWorkingCopy) {
    // Keep only the latest auto-backup: prune older ones before inserting the new.
    await db
      .delete(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL)));
    await db.insert(worldSnapshots).values({
      worldId,
      userId: currentUser.id,
      schemaData: encodeStudioSnapshotMaterial(current.schema, current.thumbnailUrl),
      label: BEFORE_ROLLBACK_LABEL,
    });
  }

  return c.json({ ok: true, restoredSnapshotId: snapshotId, held, reasons });
});

// GET /api/studio/:worldId/snapshots/:snapshotId/diff?against=auto|current
studioRoutes.get("/:worldId/snapshots/:snapshotId/diff", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");
  const against = c.req.query("against") === "current" ? "current" : "auto";

  const worldRows = await db
    .select({ id: worlds.id, schema: worlds.schema })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  const snap = await db
    .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData, createdAt: worldSnapshots.createdAt })
    .from(worldSnapshots)
    .where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId)));
  if (snap.length === 0) return c.json({ error: "Snapshot not found" }, 404);

  const current = await captureStudioCreditWorldRevision({ worldId, userId: currentUser.id });
  const currentMaterial = encodeStudioSnapshotMaterial(current.schema, current.thumbnailUrl);
  const prev = snap[0]!.schemaData;
  let next: Record<string, unknown>;
  if (against === "current") {
    next = currentMaterial;
  } else {
    // "next newer state" — MUST match the list endpoint's summarizeSnapshotTimeline
    // pairing exactly, or the expanded diff disagrees with the row's chips. Use the
    // same (createdAt, id) ordering and pick the neighbor by array position; createdAt
    // alone is not unique (an agent turn inserts several snapshots with the same now()).
    const ordered = await db
      .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData })
      .from(worldSnapshots)
      .where(eq(worldSnapshots.worldId, worldId))
      .orderBy(asc(worldSnapshots.createdAt), asc(worldSnapshots.id));
    const idx = ordered.findIndex((s) => s.id === snapshotId);
    next = idx >= 0 && idx + 1 < ordered.length ? ordered[idx + 1]!.schemaData : currentMaterial;
  }

  return c.json({ data: diffStudioSnapshotMaterials(prev, next, { detail: true }) });
});

// DELETE /api/studio/:worldId/snapshots/:snapshotId — delete one restore point
studioRoutes.delete("/:worldId/snapshots/:snapshotId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");
  const owned = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (owned.length === 0) return c.json({ error: "World not found" }, 404);
  await db.delete(worldSnapshots).where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId)));
  return c.json({ ok: true });
});

// DELETE /api/studio/:worldId/snapshots — clear all restore points for this world
studioRoutes.delete("/:worldId/snapshots", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const owned = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (owned.length === 0) return c.json({ error: "World not found" }, 404);
  await db.delete(worldSnapshots).where(eq(worldSnapshots.worldId, worldId));
  return c.json({ ok: true });
});

export { studioRoutes };
