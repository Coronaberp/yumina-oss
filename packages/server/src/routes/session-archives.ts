import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sessionArchiveSchema, replaceArchiveMediaReferences, ARCHIVE_MAX_FILE_BYTES, ARCHIVE_MAX_MEDIA_BYTES, ARCHIVE_MAX_ASSET_BYTES, type ArchiveMode, type SessionArchive } from "@yumina/shared";
import { GameStateManager, PromptBuilder, migrateWorldDefinition, resolveStoryProgress, personaPresetsSchema, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { assets, checkpoints, messages, playSessions, summaryceptionSnippets, user, userLibrary, userPersonas, worlds, worldMemories } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { resolveSessionWorldSchema } from "../lib/pending-edit.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { isSessionStreaming } from "../lib/stream-registry.js";
import { isInstallationSharedWorld } from "../lib/installation-shared-worlds.js";
import { legacySessionPersona, type SessionPersona } from "../lib/session-persona.js";
import { applyPersonaMetadata } from "../lib/persona-metadata.js";
import { putObject, deleteObject } from "../lib/s3.js";
import { imageMasters } from "../lib/image-masters.js";
import { join } from "node:path";
import { env } from "../lib/env.js";
import { ArchiveUploadStore, ArchiveUploadError, archiveImportIds, ARCHIVE_UPLOAD_CHUNK_BYTES } from "../lib/archive-upload-store.js";
import { archivePersonaSchema, archivePersonaProfileId, restoreArchivePersona } from "../lib/archive-persona.js";

class ArchiveError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 = 400) { super(message); }
}
const date = (value: Date | null | undefined) => (value ?? new Date(0)).toISOString();
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const settingsSchema = z.object({
  summary: z.string().nullable().optional(), summaryModel: z.string().nullable().optional(),
  summaryImplementation: z.enum(["localdev", "summaryception"]).optional(),
  summaryMode: z.enum(["threshold", "overflow"]).optional(),
  summaryIncluded: z.boolean().optional(), summaryTriggerTokens: z.number().int().nonnegative().nullable().optional(),
  summaryLanguage: z.enum(["auto", "en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de", "pt", "ru"]).nullable().optional(), summaryRecentTailTokens: z.number().int().nonnegative().nullable().optional(),
  summaryCoversUntilMessageId: z.string().nullable().optional(), summaryTokenCount: z.number().int().nonnegative().nullable().optional(),
  summaryceptionModel: z.string().nullable().optional(), summaryceptionIncluded: z.boolean().optional(),
  summaryceptionCoversUntilMessageId: z.string().nullable().optional(), summaryceptionTokenCount: z.number().int().nonnegative().nullable().optional(),
  sessionMemory: z.object({ text: z.string() }).nullable().optional(),
  sessionMemoryModel: z.string().nullable().optional(), sessionMemoryIncluded: z.boolean().optional(),
  sessionMemoryProcessedMessageId: z.string().nullable().optional(), sessionMemoryPinned: z.string().nullable().optional(),
  stateGuardEnabled: z.boolean().optional(), stateGuardModel: z.string().nullable().optional(),
  personaControlMode: z.enum(["player", "assisted", "ai"]).optional(),
});

/** StoryHaven's encrypted/vector storage is installation-specific. Preserve the
 * owned active facts as portable continuity notes, without profile credentials. */
async function continuityNotes(userId: string, sessionId: string): Promise<string[]> {
  const exists = (await db.execute(sql`SELECT to_regclass('storyhaven_memory_sessions') AS present`)).rows[0]?.present;
  if (!exists) return [];
  const metadata = (await db.execute(sql`SELECT m.backend FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE m.session_id=${sessionId} AND s.user_id=${userId}`)).rows[0];
  if (metadata?.backend !== "storyhaven") return [];
  const { getMemoryRuntime } = await import("../memory/runtime.js");
  const { captureSessionSnapshot, filterForgottenSnapshot } = await import("../memory/snapshots.js");
  const { decryptMemoryText } = await import("../memory/crypto.js");
  const runtime = await getMemoryRuntime();
  const profile = await runtime.profiles.getOwnActive(userId);
  if (!profile) return [];
  const snapshot = await captureSessionSnapshot(runtime.database, profile, sessionId);
  const forgotten = await runtime.database.query<{ fact_hash: string }>("SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2", [profile.id, sessionId]);
  const filtered = filterForgottenSnapshot(snapshot, new Set(forgotten.rows.map(row => row.fact_hash)), runtime.key);
  return filtered.memory_facts.filter(row => !row.superseded_by && !row.expired_ts).map(row => decryptMemoryText(String(row.text), runtime.key));
}

export async function exportSessionArchive(userId: string, sessionId: string, mode: ArchiveMode): Promise<SessionArchive> {
  const [session] = await db.select().from(playSessions).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  if (!session) throw new ArchiveError("Session not found.", 404);
  if (isSessionStreaming(sessionId)) throw new ArchiveError("Wait for the current reply to finish before exporting.", 409);
  const [world] = await db.select().from(worlds).where(eq(worlds.id, session.worldId));
  if (!world) throw new ArchiveError("World not found.", 404);
  const schema = await resolveSessionWorldSchema(world, userId) as Record<string, unknown>;
  const [account] = await db.select({ name: user.name, username: user.username, image: user.image }).from(user).where(eq(user.id, userId));
  const persona = session.sessionPersona ?? legacySessionPersona(session.state);
  const player = { name: persona.persona?.name || account?.username || account?.name || "Player", avatar: resolveImageCdn(persona.persona ? persona.persona.avatarUrl : account?.image) ?? null };
  let exportedMessages: SessionArchive["messages"];
  if (mode === "full-save") {
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(50_001);
    if (rows.length > 50_000) throw new ArchiveError("This save exceeds the 50,000-message archive limit.", 413);
    exportedMessages = rows.map(message => ({ ...message, createdAt: date(message.createdAt) }));
  } else {
    // Transcript display needs only the selected speaker prefix, not every
    // inactive reply, reasoning body, audit or historical state snapshot.
    const rows = await db.select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt, attachments: messages.attachments,
      activeRawContent: sql<string | null>`case when coalesce(${messages.activeSwipeIndex}, 0) >= 0 then (${messages.swipes} -> coalesce(${messages.activeSwipeIndex}, 0)) ->> 'rawContent' end`,
    }).from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(50_001);
    if (rows.length > 50_000) throw new ArchiveError("This save exceeds the 50,000-message archive limit.", 413);
    exportedMessages = rows.map(message => {
      const speaker = /^\s*\[[\s\u200b\u2060]*(?:speaker|name)\s*:\s*([^:\]\n]+)/i.exec(message.activeRawContent ?? "")?.[1]?.trim();
      return { id: message.id, role: message.role, content: message.content, createdAt: date(message.createdAt), attachments: message.attachments,
        ...(speaker !== undefined ? { presentationSpeaker: speaker } : {}) };
    });
  }
  const archive: SessionArchive = {
    format: "yumina-chat", version: 1, mode, exportedAt: new Date().toISOString(),
    session: { id: session.id, name: session.name, createdAt: date(session.createdAt), updatedAt: date(session.updatedAt) },
    world: { id: world.id, name: world.name, description: world.description ?? "", thumbnailUrl: resolveImageCdn(world.thumbnailUrl), ...(mode === "full-save" ? { schema } : {}) },
    player, messages: exportedMessages, participants: [], display: [], assets: {},
  };
  if (mode === "full-save") {
    const savedCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.sessionId, sessionId));
    const memories = await db.select().from(worldMemories).where(and(eq(worldMemories.sessionId, sessionId), eq(worldMemories.userId, userId)));
    const snippets = await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sessionId));
    archive.restore = {
      state: jsonCopy(session.state), persona: jsonCopy(persona) as unknown as Record<string, unknown>,
      settings: Object.fromEntries(Object.keys(settingsSchema.shape).map(key => [key, (session as unknown as Record<string, unknown>)[key]])),
      checkpoints: savedCheckpoints.map(cp => ({ id: cp.id, name: cp.name, state: cp.state, messages: jsonCopy(cp.messages) as SessionArchive["messages"], summary: cp.summary, createdAt: date(cp.createdAt) })),
      memories: memories.map(m => ({ content: m.content, category: m.category, importance: m.importance, createdAt: date(m.createdAt) })),
      snippets: jsonCopy(snippets), continuityNotes: await continuityNotes(userId, sessionId),
    };
  }
  // The display helper gets only the source data it needs. In transcript mode
  // retain character identities, never creator prompts or private save metadata.
  archive.participants = [
    { id: "player", name: player.name, avatar: player.avatar }, { id: "narrator", name: "Narrator", avatar: null },
    ...((schema.entries ?? []) as Array<Record<string, unknown>>).filter(e => e.role === "character" && e.enabled !== false).map(e => ({ id: `character:${String(e.name).replace(/^[^:：]{1,12}[:：]\s*/, "")}`, name: String(e.name).replace(/^[^:：]{1,12}[:：]\s*/, ""), avatar: typeof e.portrait === "string" ? e.portrait : null })),
  ];
  return sessionArchiveSchema.parse(archive);
}

/** Recursively remap source identifiers and asset references, including virtual
 * interface source files. Object.fromEntries avoids prototype assignment. */
function remap(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (replacements.has(value)) return replacements.get(value)!;
    return replaceArchiveMediaReferences(value, replacements);
  }
  if (Array.isArray(value)) return value.map(item => remap(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, replacements)]));
  return value;
}

export interface ArchiveImportOptions { contextSessionId?: string; sessionId?: string; worldId?: string; }

export async function importSessionArchive(userId: string, input: unknown, options: ArchiveImportOptions = {}): Promise<{ sessionId: string; worldId: string }> {
  const parsed = sessionArchiveSchema.safeParse(input);
  if (!parsed.success) throw new ArchiveError("This archive is incomplete or uses an unsupported format/version.");
  const archive = parsed.data;
  const settings = settingsSchema.safeParse(archive.restore?.settings ?? {});
  const persona = archivePersonaSchema.safeParse(archive.restore?.persona ?? { persona: { name: archive.player.name, avatarUrl: archive.player.avatar }, started: true });
  if (!settings.success || !persona.success) throw new ArchiveError("Invalid saved settings or player identity.");
  const sessionId = options.sessionId ?? randomUUID();
  if (options.sessionId) {
    const [existing] = await db.select({ userId: playSessions.userId, worldId: playSessions.worldId }).from(playSessions).where(eq(playSessions.id, sessionId));
    if (existing?.userId === userId) return { sessionId, worldId: existing.worldId };
    if (existing) throw new ArchiveError("This import conflicts with an existing session.", 409);
  }
  let adminPreview = false;
  let worldId = archive.world.id;
  let transcriptState: Record<string, unknown> = {};
  let personaPresetSource = archive.world.schema?.personaPresets;
  if (archive.mode === "full-save") {
    worldId = options.worldId ?? randomUUID();
    if (!Array.isArray(archive.world.schema?.entries) || (archive.world.schema?.variables !== undefined && !Array.isArray(archive.world.schema.variables))) throw new ArchiveError("Invalid world definition.");
  } else {
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    if (world && world.creatorId !== userId && world.status !== "published" && !isInstallationSharedWorld(worldId, world.status) && options.contextSessionId) {
      const [account] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
      const [context] = account?.role === "admin" ? await db.select({ id: playSessions.id }).from(playSessions).where(and(eq(playSessions.id, options.contextSessionId), eq(playSessions.userId, userId), eq(playSessions.worldId, worldId), eq(playSessions.ephemeral, true))) : [];
      adminPreview = !!context;
    }
    if (!world || !(world.creatorId === userId || world.status === "published" || isInstallationSharedWorld(worldId, world.status) || adminPreview)) throw new ArchiveError("Import this transcript from its original card, or use a full save to include the world.", 404);
    const definition = migrateWorldDefinition(await resolveSessionWorldSchema(world, userId) as WorldDefinition);
    personaPresetSource = definition.personaPresets;
    const manager = new GameStateManager(definition);
    applyPersonaMetadata(manager, persona.data.persona, { name: archive.player.name });
    const greeting = new PromptBuilder().buildGreetingEntries(definition)[0];
    for (const [key, value] of Object.entries(greeting?.initialVariables ?? {})) manager.set(key, value);
    const state = manager.getSnapshot(); if (greeting) state.activeGreetingId = greeting.id;
    transcriptState = resolveStoryProgress(definition, state, { selectEnding: false }) as unknown as Record<string, unknown>;
  }
  const presets = personaPresetsSchema.safeParse(personaPresetSource ?? []);
  const personaPresetIds = new Set(presets.success ? presets.data.map(preset => preset.id) : []);
  const profileId = archivePersonaProfileId(persona.data);
  const [ownedProfile] = profileId ? await db.select({ id: userPersonas.id }).from(userPersonas)
    .where(and(eq(userPersonas.id, profileId), eq(userPersonas.userId, userId))).limit(1) : [];
  const restoredPersona = restoreArchivePersona(persona.data, { ownedProfileId: ownedProfile?.id, presetIds: personaPresetIds });
  const replacements = new Map([[archive.session.id, sessionId], ...(archive.mode === "full-save" ? [[archive.world.id, worldId] as [string, string]] : [])]);
  for (const [index, message] of archive.messages.entries()) replacements.set(message.id, `${index.toString(16).padStart(8, "0")}-${randomUUID().slice(9)}`);
  for (const checkpoint of archive.restore?.checkpoints ?? []) {
    replacements.set(checkpoint.id, randomUUID());
    for (const message of checkpoint.messages) if (!replacements.has(message.id)) replacements.set(message.id, randomUUID());
  }
  const staged: Array<{ id: string; key: string; mime: string; base64: string; sizeBytes: number }> = [];
  const assetsByData = new Map<string, string>();
  // Transcript imports reuse the existing card's media. Offline HTML portraits
  // are not new uploads; only full saves restore their embedded asset bundle.
  for (const [source, data] of archive.mode === "full-save" ? Object.entries(archive.assets) : []) {
    const existing = assetsByData.get(data);
    if (existing) { replacements.set(source, source.startsWith("@asset:") ? `@asset:${existing}` : resolveImageCdn(existing)!); continue; }
    const [, mime, base64] = /^data:([^;]+);base64,(.*)$/.exec(data)!;
    // The archive schema already restricts base64 to its alphabet and trailing
    // padding. Count decoded bytes without retaining a Buffer for every asset.
    const encodedLength = base64!.indexOf("=") < 0 ? base64!.length : base64!.indexOf("=");
    const sizeBytes = Math.floor(encodedLength * 3 / 4);
    if (!sizeBytes || sizeBytes > ARCHIVE_MAX_ASSET_BYTES) throw new ArchiveError("An embedded asset is empty or exceeds 100 MB.", 413);
    const id = randomUUID();
    const key = `users/${userId}/archives/${sessionId}/${id}`;
    staged.push({ id, key, mime: mime!, base64: base64!, sizeBytes });
    assetsByData.set(data, id);
    replacements.set(source, source.startsWith("@asset:") ? `@asset:${id}` : resolveImageCdn(id)!);
    if (source.startsWith("@asset:")) replacements.set(`/cdn/${source.slice(7)}`, resolveImageCdn(id)!);
    replacements.set(data, resolveImageCdn(id)!);
  }
  if (staged.reduce((size, asset) => size + asset.sizeBytes, 0) > ARCHIVE_MAX_MEDIA_BYTES) throw new ArchiveError("Embedded media exceeds 350 MB.", 413);
  const written: string[] = [];
  try {
    for (const asset of staged) {
      const bytes = Buffer.from(asset.base64, "base64");
      if (bytes.length !== asset.sizeBytes) throw new ArchiveError("An embedded asset has invalid base64 data.");
      if (asset.mime.startsWith("image/")) {
        const master = await imageMasters.store({ userId, access: "public", bytes, mimeType: asset.mime });
        asset.key = master.key;
        asset.mime = master.mimeType;
      } else {
        await putObject(asset.key, bytes, asset.mime); written.push(asset.key);
      }
    }
    await db.transaction(async tx => {
      if (archive.mode === "full-save") {
        const schema = remap(archive.world.schema, replacements) as Record<string, unknown>;
        // Compiled bundles contain old asset IDs. The normal sandbox compiler
        // rebuilds from these remapped authored files on first render.
        for (const root of [schema.rootComponent, ...Object.values((schema.interfaceDrafts ?? {}) as Record<string, unknown>)]) if (root && typeof root === "object") delete (root as Record<string, unknown>).compiled;
        await tx.insert(worlds).values({ id: worldId, creatorId: userId, name: archive.world.name, description: archive.world.description, schema, thumbnailUrl: archive.world.thumbnailUrl ? remap(archive.world.thumbnailUrl, replacements) as string : null, status: "draft" });
      }
      const identity = remap(restoredPersona, replacements) as SessionPersona;
      // Account profile IDs are destination-owned references, not archive IDs.
      if (restoredPersona.persona?.id && restoredPersona.selection?.kind !== "preset") {
        identity.persona!.id = restoredPersona.persona.id;
        identity.selection = restoredPersona.selection;
      }
      const config = remap(settings.data, replacements) as typeof settings.data;
      const pinned = [config.sessionMemoryPinned, ...(archive.restore?.continuityNotes ?? [])].filter(Boolean).join("\n\n") || null;
      await tx.insert(playSessions).values({
        ...config, id: sessionId, userId, worldId, name: archive.session.name ? `${archive.session.name} (imported)` : "Imported chat",
        state: remap(archive.restore?.state ?? transcriptState, replacements) as Record<string, unknown>,
        sessionPersona: identity, personaLocked: true, sessionMemoryPinned: pinned, ephemeral: adminPreview,
        summaryStatus: "idle", summaryceptionStatus: "idle", sessionMemoryStatus: "idle",
        summarySourceHash: null, sessionMemorySourceHash: null, summaryceptionSourceHash: null,
        createdAt: new Date(archive.session.createdAt), updatedAt: new Date(),
      } as typeof playSessions.$inferInsert);
      for (const asset of staged) {
        const values = { id: asset.id, type: asset.mime.startsWith("image/") ? "image" as const : asset.mime.startsWith("audio/") ? "audio" as const : asset.mime.startsWith("video/") ? "video" as const : asset.mime.startsWith("font/") ? "font" as const : "other" as const, filename: asset.id, url: asset.key, mimeType: asset.mime, sizeBytes: asset.sizeBytes };
        await tx.insert(assets).values({ ...values, worldId });
      }
      const rows = archive.messages.map(source => {
        const m = remap(source, replacements) as typeof source;
        return { id: replacements.get(source.id)!, sessionId, role: m.role, content: m.content, status: m.status === "failed" ? "failed" as const : "complete" as const,
          errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
          swipes: (m.swipes ?? (typeof m.presentationSpeaker === "string" ? [{ content: m.content, rawContent: `[speaker: ${m.presentationSpeaker}]\n${m.content}`, createdAt: m.createdAt }] : [])) as typeof messages.$inferInsert.swipes, activeSwipeIndex: m.activeSwipeIndex ?? 0,
          stateChanges: m.stateChanges as Record<string, unknown> | undefined, stateSnapshot: m.stateSnapshot as Record<string, unknown> | undefined,
          stateValidation: m.stateValidation as typeof messages.$inferInsert.stateValidation, contentFlags: m.contentFlags as typeof messages.$inferInsert.contentFlags,
          model: typeof m.model === "string" ? m.model : null, attachments: m.attachments?.map(a => ({ ...a, url: a.url.startsWith("@asset:") ? `/cdn/${a.url.slice(7)}` : a.url })),
          tokenCount: typeof m.tokenCount === "number" && Number.isSafeInteger(m.tokenCount) && m.tokenCount >= 0 ? m.tokenCount : null,
          generationTimeMs: typeof m.generationTimeMs === "number" && Number.isSafeInteger(m.generationTimeMs) && m.generationTimeMs >= 0 ? m.generationTimeMs : null,
          compacted: archive.mode === "full-save" && !!config.summary && m.compacted === true,
          summaryceptionCompacted: archive.mode === "full-save" && !!archive.restore?.snippets.length && m.summaryceptionCompacted === true,
          // Ordered fresh UUID prefixes preserve source order for tied dates.
          createdAt: new Date(m.createdAt),
        };
      });
      for (let start = 0; start < rows.length; start += 200) await tx.insert(messages).values(rows.slice(start, start + 200));
      for (const source of archive.restore?.checkpoints ?? []) {
        const cp = remap(source, replacements) as typeof source;
        await tx.insert(checkpoints).values({ id: cp.id, sessionId, name: cp.name, state: cp.state, summary: cp.summary, messages: cp.messages.map(m => ({ ...m, sessionId })), createdAt: new Date(cp.createdAt) });
      }
      for (const m of archive.restore?.memories ?? []) await tx.insert(worldMemories).values({ ...m, userId, worldId, sessionId, createdAt: new Date(m.createdAt) });
      const snippetSchema = z.object({ layerIndex: z.number().int().nonnegative(), snippetOrder: z.number().int().nonnegative(), text: z.string(), sourceStartMessageId: z.string().nullable().optional(), sourceEndMessageId: z.string().nullable().optional(), sourceStartOrdinal: z.number().int().nullable().optional(), sourceEndOrdinal: z.number().int().nullable().optional(), fromLayer: z.number().int().nullable().optional(), mergedCount: z.number().int().nullable().optional(), promoted: z.boolean().optional() });
      for (const source of archive.restore?.snippets ?? []) await tx.insert(summaryceptionSnippets).values({ ...snippetSchema.parse(remap(source, replacements)), sessionId });
      if (!adminPreview) await tx.insert(userLibrary).values({ userId, worldId }).onConflictDoNothing();
    });
  } catch (error) {
    await Promise.allSettled(written.map(key => deleteObject(key)));
    if (options.sessionId) {
      const [saved] = await db.select({ userId: playSessions.userId, worldId: playSessions.worldId }).from(playSessions).where(eq(playSessions.id, options.sessionId));
      if (saved?.userId === userId) return { sessionId, worldId: saved.worldId };
    }
    throw error;
  }
  return { sessionId, worldId };
}

const uploadStore = new ArchiveUploadStore(join(env.YUMINA_DATA_DIR, "archive-imports"));
function archiveFailure(c: Context<AppEnv>, error: unknown) {
  // Hono raises this while the handler consumes a body without Content-Length.
  // Keep the explicit JSON 413 instead of swallowing it as an import failure.
  if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Archive request exceeds the allowed upload size." }, 413);
  if (error instanceof ArchiveError || error instanceof ArchiveUploadError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid archive JSON or saved data." }, 400);
  console.error("Archive import request failed:", error instanceof Error ? error.name : typeof error);
  return c.json({ error: "The archive import could not be confirmed. Retry checks the same import attempt." }, 500);
}
async function completedImport(owner: string, requestId: string) {
  const ids = archiveImportIds(owner, requestId);
  const [session] = await db.select({ worldId: playSessions.worldId }).from(playSessions).where(and(eq(playSessions.id, ids.sessionId), eq(playSessions.userId, owner)));
  return session ? { sessionId: ids.sessionId, worldId: session.worldId } : null;
}
export const sessionArchiveRoutes = new Hono<AppEnv>();
sessionArchiveRoutes.use("/*", authMiddleware);
sessionArchiveRoutes.use("/*", bodyLimit({ maxSize: ARCHIVE_MAX_FILE_BYTES, onError: c => c.json({ error: "Archive exceeds the 512 MB file limit." }, 413) }));
sessionArchiveRoutes.get("/:id", async c => {
  const mode = c.req.query("mode") === "full-save" ? "full-save" : "transcript";
  try { return c.json({ data: await exportSessionArchive(c.get("user").id, c.req.param("id"), mode) }); }
  catch (error) { return archiveFailure(c, error); }
});
sessionArchiveRoutes.post("/import", async c => {
  try {
    const requestId = c.req.header("X-Yumina-Archive-Request");
    const options = { contextSessionId: c.req.header("X-Yumina-Archive-Session"), ...(requestId ? archiveImportIds(c.get("user").id, requestId) : {}) };
    return c.json({ data: await importSessionArchive(c.get("user").id, await c.req.json(), options) }, 201);
  } catch (error) { return archiveFailure(c, error); }
});
sessionArchiveRoutes.post("/uploads/:requestId", async c => {
  try {
    const owner = c.get("user").id, id = c.req.param("requestId");
    const input = z.object({ totalBytes: z.number().int().positive().max(ARCHIVE_MAX_FILE_BYTES), contextSessionId: z.string().min(1).max(200).optional() }).parse(await c.req.json());
    const result = await completedImport(owner, id);
    return c.json({ data: result ? { state: "complete", totalBytes: input.totalBytes, receivedBytes: input.totalBytes, result } : await uploadStore.create(owner, id, input.totalBytes, input.contextSessionId) });
  } catch (error) { return archiveFailure(c, error); }
});
sessionArchiveRoutes.get("/uploads/:requestId", async c => {
  try {
    const owner = c.get("user").id, id = c.req.param("requestId");
    const result = await completedImport(owner, id);
    return c.json({ data: result ? { state: "complete", totalBytes: 0, receivedBytes: 0, result } : await uploadStore.status(owner, id) });
  } catch (error) { return archiveFailure(c, error); }
});
sessionArchiveRoutes.put("/uploads/:requestId/chunks/:offset", bodyLimit({ maxSize: ARCHIVE_UPLOAD_CHUNK_BYTES, onError: c => c.json({ error: "Archive chunk exceeds 4 MB." }, 413) }), async c => {
  try {
    if (!/^\d+$/.test(c.req.param("offset"))) throw new ArchiveUploadError("Invalid archive upload offset.");
    return c.json({ data: await uploadStore.append(c.get("user").id, c.req.param("requestId"), Number(c.req.param("offset")), Buffer.from(await c.req.arrayBuffer())) });
  } catch (error) { return archiveFailure(c, error); }
});
sessionArchiveRoutes.post("/uploads/:requestId/complete", async c => {
  try {
    const owner = c.get("user").id, id = c.req.param("requestId");
    const result = await completedImport(owner, id) ?? await uploadStore.complete(owner, id, async (json, contextSessionId) => {
      if (json.trimStart().startsWith("<")) throw new ArchiveUploadError("Choose an HTML archive through the import dialog so its embedded JSON can be extracted.");
      return importSessionArchive(owner, JSON.parse(json), { ...archiveImportIds(owner, id), contextSessionId });
    });
    return c.json({ data: result }, 201);
  } catch (error) { return archiveFailure(c, error); }
});
