import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { resolveMemoryRecallBudget, memoryRecallBudgetSchema } from "@yumina/shared";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { viewerSeesWorkingCopy } from "../lib/working-copy.js";
import { db } from "../db/index.js";
import { getMemoryRuntime, createMemoryModel } from "./runtime.js";
import {
  logicalTranscript,
  memoryWorldHash,
  prefixAt,
  sourceFingerprint,
} from "./provenance.js";
import { exchanges, retrieveKeywordLore } from "./retrieval.js";
import { ensureIdentity, quoteSchema } from "./schema.js";
import { createEmbeddingClient } from "./embeddings.js";
import {
  CANONICAL_TABLES,
  insertCanonical,
  type CanonicalData,
} from "./profile-reindex.js";
import {
  loadSessionSnapshot,
  saveSessionSnapshot,
  remapSnapshot,
  filterForgottenSnapshot,
  snapshotSessionId,
} from "./snapshots.js";
import type {
  EmbeddingProfile,
  MemoryDatabase,
  MemoryScope,
  TranscriptMessage,
  TurnMemoryContext,
  MemoryResult,
  LoreEntry,
} from "./types.js";
import type { MemoryJobClaim } from "./jobs.js";
import { materializePendingMemoryFork } from "./fork.js";
import {
  reconcileAuthoredLore,
  visibleLoreRepositories,
  type AuthoredLoreEntry,
} from "./authored-lore.js";
import { estimateTokens } from "@yumina/engine";
import { storyCharacterKeywords } from "../lib/story-character-context.js";
import { identityRoleMatches, requestsCharacterLookup, explicitlyEmptyCharacterScene } from "../lib/story-character-identity.js";

export interface AdapterContext extends TurnMemoryContext {
  settings: Record<string, unknown>;
  defaultMemoryBudgetTokens?: number;
  accountMemoryBudgetTokens?: unknown;
  frontier: number;
  model: string;
  modelProfileId?: string;
  parentSessionId: string | null;
  backend: "legacy" | "storyhaven" | null;
  worldHash: string;
  resetEpoch: number;
  promptWorldHash?: string;
  promptWorldMigrationStamp?: boolean;
}
export interface TurnContextInput {
  ownerUserId: string;
  actingUserId: string;
  sessionId: string;
  cutoffMessageId?: string | null;
  query?: string;
  world?: WorldDefinition;
  model?: string;
  /** Available space in the complete prompt, not an independent memory allowance. */
  memoryBudgetTokens?: number;
  characterEntryIds?: string[];
  /** Request-only placeholder values, never part of canonical lore/source hashes. */
  loreWardrobeValues?: Record<string, string>;
}
/** Internal route provenance, captured before the story reply queues memory. */
export async function rememberStoryhavenModelRoute(sessionId: string, actingUserId: string, model: string, profileId?: string): Promise<void> {
  await db.execute(sql`UPDATE storyhaven_memory_sessions SET story_model=${model},story_profile_id=${profileId ?? null}
    WHERE session_id=${sessionId} AND EXISTS(SELECT 1 FROM play_sessions WHERE id=${sessionId} AND user_id=${actingUserId})`);
}

export function memoryTranscriptRow(r: {
  id: string;
  role: string;
  content: string;
  activeSwipeIndex?: number | null;
  swipes?: Array<Record<string, unknown>> | null;
}): TranscriptMessage {
  const selected = r.swipes?.[r.activeSwipeIndex ?? 0] ?? {
    content: r.content,
  };
  // Keep this aligned with the message invalidation trigger: billing and
  // moderation receipts do not revise the story an extraction already read.
  const { contentFlags: _flags, creditCost: _cost, creditBalanceAfter: _balance, ...story } = selected;
  const selectedAnswerId = createHash("sha256")
    .update(JSON.stringify(story))
    .digest("hex");
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    selectedAnswerId,
    sourceVersion: createHash("sha256")
      .update(JSON.stringify([r.role, r.content, selectedAnswerId]))
      .digest("hex"),
  };
}

function normalizedPromptWorldHash(
  world: WorldDefinition,
  ignoreMigrationStamp = false,
): string {
  const normalized = migrateWorldDefinition(structuredClone(world));
  // Legacy migrations synthesize a current-time UI stamp; it is not prompt content.
  if (ignoreMigrationStamp && normalized.rootComponent) {
    normalized.rootComponent = { ...normalized.rootComponent, updatedAt: "" };
  }
  delete normalized.rootComponent;
  return createHash("sha256")
    .update(
      JSON.stringify(normalized, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .digest("hex");
}

async function sessionRow(
  sessionId: string,
  ownerUserId: string,
  actingUserId = ownerUserId,
) {
  const result =
    await db.execute(sql`SELECT s.*,u.name AS user_name,u.preferences->'aiConfig'->'memoryBudgetTokens' AS account_memory_budget,u.preferences->'aiConfig'->>'selectedModel' AS account_story_model,
    (SELECT COALESCE(a.swipes->COALESCE(a.active_swipe_index,0)->>'model',a.model) FROM messages a WHERE a.session_id=s.id AND a.role='assistant' AND a.model IS NOT NULL ORDER BY COALESCE(a.created_at,'1970-01-01'::timestamp) DESC,a.id DESC LIMIT 1) AS latest_story_model,
    w.schema AS world_schema,w.name AS world_name,w.status AS world_status,w.creator_id AS world_creator_id,p.schema AS pending_world_schema,m.backend,m.epoch,m.frontier,m.settings,m.reset_epoch,m.story_model,m.story_profile_id
    FROM play_sessions s JOIN "user" u ON u.id=s.user_id JOIN worlds w ON w.id=s.world_id
    LEFT JOIN world_pending_edits p ON p.world_id=w.id
    LEFT JOIN storyhaven_memory_sessions m ON m.session_id=s.id WHERE s.id=${sessionId} AND s.user_id=${ownerUserId}`);
  const row = result.rows[0];
  if (!row) throw new Error("memory_session_unavailable");
  if (
    viewerSeesWorkingCopy(
      String(row.world_status),
      String(row.world_creator_id),
      actingUserId,
    ) &&
    row.pending_world_schema
  )
    row.world_schema = row.pending_world_schema;
  return row;
}
/** Keyset pagination includes compacted rows and uses the same deterministic identity order for every operation. */
async function history(sessionId: string): Promise<TranscriptMessage[]> {
  const result: TranscriptMessage[] = [];
  let after: { time: unknown; id: string } | undefined;
  while (true) {
    const rows = (
      await db.execute(sql`SELECT id,role,content,created_at,active_swipe_index,swipes FROM messages WHERE session_id=${sessionId}
      ${after ? sql`AND (COALESCE(created_at,'1970-01-01'::timestamp),id)>(${after.time}::timestamp,${after.id})` : sql``}
      ORDER BY COALESCE(created_at,'1970-01-01'::timestamp),id LIMIT 1000`)
    ).rows;
    for (const r of rows) {
      result.push(
        memoryTranscriptRow({
          id: String(r.id),
          role: String(r.role),
          content: String(r.content),
          activeSwipeIndex: Number(r.active_swipe_index ?? 0),
          swipes: r.swipes as Array<Record<string, unknown>> | null,
        }),
      );
    }
    if (rows.length < 1000) break;
    const last = rows.at(-1)!;
    after = { time: last.created_at ?? "1970-01-01", id: String(last.id) };
  }
  return result;
}
export async function loadStoryhavenTurnContext(
  input: TurnContextInput,
): Promise<AdapterContext> {
  await db.execute(
    sql`INSERT INTO storyhaven_memory_sessions(session_id) SELECT id FROM play_sessions WHERE id=${input.sessionId} AND user_id=${input.ownerUserId} ON CONFLICT DO NOTHING`,
  );
  const session = await sessionRow(
    input.sessionId,
    input.ownerUserId,
    input.actingUserId,
  );
  const sourceWorld = session.world_schema as WorldDefinition;
  const world =
    input.world ?? migrateWorldDefinition(structuredClone(sourceWorld));
  const ignoreMigrationStamp =
    !sourceWorld.rootComponent &&
    parseFloat(String(sourceWorld.version ?? 0)) < 20;
  const raw = prefixAt(
    await history(input.sessionId),
    input.cutoffMessageId ?? null,
  );
  const messages = logicalTranscript(raw);
  const castNames = (world.entries ?? [])
    .filter((e) => e.enabled !== false && e.role === "character")
    .map((e) => e.name);
  const persona = session.session_persona as {
    persona?: { name?: string };
  } | null;
  const settings = (session.settings ?? {}) as Record<string, unknown>;
  const entries = (world.entries ?? []).filter(
    (e) =>
      (e.enabled !== false || (e.role === "character" && input.characterEntryIds?.includes(e.id))) &&
      (e.role === "character" || e.role === "lore" || (e.role === "custom" && e.memory !== undefined)),
  );
  const characterKeys = storyCharacterKeywords(entries.filter(e => e.role === "character"));
  const loreEntries: LoreEntry[] = entries.map((e) => ({
    id: `${session.world_id}:${e.id}`,
    name: e.name,
    content: e.content,
    char_id: String(session.world_id),
    keys: e.role === "character" ? characterKeys.get(e.id) : e.keywords,
    require_keys:
      e.secondaryKeywordLogic === "AND_ALL" ? (e.secondaryKeywords ?? []) : [],
    exclude_keys: e.secondaryKeywordLogic?.startsWith("NOT")
      ? (e.secondaryKeywords ?? [])
      : [],
    always: e.role === "character" ? false : e.alwaysSend,
    category: e.role,
    metadata:
      (e as unknown as { memory?: { metadata?: Record<string, unknown> } })
        .memory?.metadata ?? {},
    ...((e as unknown as { memory?: Record<string, unknown> }).memory ?? {}),
    ...(e.role === "character" ? { always: false } : {}),
  }));
  return {
    ownerUserId: input.ownerUserId,
    actingUserId: input.actingUserId,
    sessionId: input.sessionId,
    worldId: String(session.world_id),
    mode: castNames.length > 1 ? "group" : "solo",
    epoch: Number(session.epoch ?? 0),
    sourceHash: sourceFingerprint(messages),
    cutoffMessageId: input.cutoffMessageId ?? null,
    query:
      input.query ||
      [...messages].reverse().find((r) => r.role === "user")?.content ||
      "",
    messages,
    charName: castNames[0] ?? String(world.name ?? session.world_name),
    userName: persona?.persona?.name ?? String(session.user_name),
    language: String(
      settings.language ??
        (session.summary_language === "auto"
          ? "the same language as the story"
          : session.summary_language) ??
        "English",
    ),
    castNames: castNames.length > 1 ? castNames : [],
    canonicalLocation: "",
    loreEntries,
    settings,
    defaultMemoryBudgetTokens: resolveMemoryRecallBudget(undefined, session.account_memory_budget),
    accountMemoryBudgetTokens: session.account_memory_budget,
    frontier: Number(session.frontier ?? 0),
    model: String(
      settings.model ??
        input.model ??
        session.story_model ??
        session.latest_story_model ??
        session.account_story_model ??
        session.session_memory_model ??
        "openrouter/free",
    ),
    ...(!settings.model && (!input.model || input.model === session.story_model) && session.story_profile_id
      ? { modelProfileId: String(session.story_profile_id) } : {}),
    parentSessionId: session.parent_session_id as string | null,
    backend: session.backend as AdapterContext["backend"],
    resetEpoch: Number(session.reset_epoch ?? 0),
    promptWorldHash: input.world
      ? normalizedPromptWorldHash(input.world, ignoreMigrationStamp)
      : undefined,
    promptWorldMigrationStamp: input.world ? ignoreMigrationStamp : undefined,
    worldHash: memoryWorldHash(session.world_schema),
  };
}
export async function ensureStoryhavenSnapshotCurrent(
  ctx: TurnMemoryContext,
): Promise<boolean> {
  try {
    const row = await sessionRow(
      ctx.sessionId,
      ctx.ownerUserId,
      ctx.actingUserId,
    );
    if (Number(row.epoch ?? 0) !== ctx.epoch) return false;
    if (
      "promptWorldHash" in ctx &&
      ctx.promptWorldHash &&
      ctx.promptWorldHash !==
        normalizedPromptWorldHash(
          row.world_schema as WorldDefinition,
          "promptWorldMigrationStamp" in ctx &&
            ctx.promptWorldMigrationStamp === true,
        )
    )
      return false;
    if (
      "worldHash" in ctx &&
      ctx.worldHash !== memoryWorldHash(row.world_schema)
    )
      return false;
    const raw = await history(ctx.sessionId);
    const end = ctx.messages.at(-1)?.id;
    const current = ctx.cutoffMessageId
      ? prefixAt(raw, ctx.cutoffMessageId)
      : end
        ? raw.slice(0, raw.findIndex((r) => r.id === end) + 1)
        : [];
    return sourceFingerprint(logicalTranscript(current)) === ctx.sourceHash;
  } catch {
    return false;
  }
}
const emptyResult = (
  ctx: TurnMemoryContext,
  profileId = "",
  status: MemoryResult["status"] = "pending",
): MemoryResult => ({
  block: "",
  usedIds: [],
  droppedIds: [],
  loreLines: [],
  memoryLines: [],
  profileId,
  epoch: ctx.epoch,
  sourceHash: ctx.sourceHash,
  status,
});
export const scopeFor = (
  p: EmbeddingProfile,
  ctx: TurnMemoryContext,
): MemoryScope => ({
  profileId: p.id,
  schemaName: p.schemaName,
  ownerUserId: ctx.ownerUserId,
  sessionId: ctx.sessionId,
  charId: ctx.worldId,
});
export const settledPairs = (ctx: AdapterContext): number =>
  Math.max(
    0,
    exchanges(ctx.messages, ctx.mode === "group").length -
      Number(ctx.settings.settleMarginExchanges ?? 1),
  );
const SESSION_TABLES = [
  "memory_facts",
  "memory_extract_cursors",
  "memory_extract_batches",
  "memory_reinforce_log",
  "session_secret_reveals",
  "session_lore_state",
  "memory_clusters",
  "memory_cluster_items",
  "memory_vectors",
  "cluster_vectors",
] as const;

export async function purgeDerived(
  database: MemoryDatabase,
  profile: EmbeddingProfile,
  sessionId: string,
): Promise<void> {
  const s = quoteSchema(profile.schemaName);
  await database.transaction(async (tx) => {
    if (
      !(
        await tx.query(
          "SELECT id FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 FOR SHARE",
          [profile.id, profile.userId],
        )
      ).rows.length
    )
      return;
    await tx.query(
      `DELETE FROM ${s}.memory_cluster_items WHERE cluster_id IN (SELECT id FROM ${s}.memory_clusters WHERE session_id=$1)`,
      [sessionId],
    );
    for (const table of SESSION_TABLES)
      if (table !== "memory_cluster_items")
        await tx.query(`DELETE FROM ${s}.${table} WHERE session_id=$1`, [
          sessionId,
        ]);
    await tx.query(`DELETE FROM ${s}.sessions WHERE id=$1`, [sessionId]);
  });
}
export async function restoreDerived(
  database: MemoryDatabase,
  profile: EmbeddingProfile,
  scope: MemoryScope,
  input: CanonicalData,
): Promise<void> {
  await database.transaction(async (tx) => {
    if (
      !(
        await tx.query(
          "SELECT id FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 FOR SHARE",
          [profile.id, profile.userId],
        )
      ).rows.length
    )
      throw new Error("memory_profile_unavailable");
    await purgeDerived(tx, profile, scope.sessionId);
    await ensureIdentity(tx, scope);
    const copy = Object.fromEntries(
      CANONICAL_TABLES.map((t) => [
        t,
        SESSION_TABLES.includes(t as never) ? input[t] : [],
      ]),
    ) as CanonicalData;
    await insertCanonical(tx, profile, copy);
    const scene = input.sessions[0];
    if (scene)
      await tx.query(
        `UPDATE ${quoteSchema(profile.schemaName)}.sessions SET char_doing=$2,char_location=$3,known_names=$4 WHERE id=$1`,
        [
          scope.sessionId,
          scene.char_doing,
          scene.char_location,
          scene.known_names,
        ],
      );
  });
}
async function prepareSnapshotVectors(
  data: CanonicalData,
  profile: EmbeddingProfile,
  originalProfileId: string,
  key: Uint8Array,
  embedding: ReturnType<typeof createEmbeddingClient>,
) {
  if (originalProfileId === profile.id) return;
  const { decryptMemoryText } = await import("./crypto.js");
  for (const row of data.memory_facts)
    row.embedding = JSON.stringify(
      await embedding.embed(decryptMemoryText(String(row.text), key)),
    );
  for (const row of data.memory_vectors)
    row.embedding = JSON.stringify(
      await embedding.embed(decryptMemoryText(String(row.text), key)),
    );
  for (const row of data.cluster_vectors) {
    const cluster = data.memory_clusters.find((c) => c.id === row.cluster_id);
    if (cluster)
      row.embedding = JSON.stringify(
        await embedding.embed(
          decryptMemoryText(String(cluster.summary_text), key),
        ),
      );
  }
}
export async function storyhavenBackendEnabled(
  ctx: AdapterContext,
): Promise<boolean> {
  if (ctx.backend === "legacy") return false;
  if (ctx.backend === "storyhaven") return true;
  return false;
}

export async function retrieveStoryhavenMemory(
  input: TurnContextInput,
): Promise<{
  enabled: boolean;
  context: AdapterContext;
  result: MemoryResult;
}> {
  const ctx = await loadStoryhavenTurnContext(input);
  const enabled = await storyhavenBackendEnabled(ctx);
  if (!enabled)
    return {
      enabled,
      context: ctx,
      result: emptyResult(ctx, "", "unconfigured"),
    };
  await materializePendingMemoryFork(ctx.ownerUserId, ctx.sessionId);
  const r = await getMemoryRuntime();
  const profile = await r.profiles.getActive(ctx.ownerUserId);
  if (!profile)
    return {
      enabled,
      context: ctx,
      result: emptyResult(ctx, "", "unconfigured"),
    };
  // The first pass resolves branch/history provenance. The composed request
  // supplies the real remaining budget before any query embedding is made.
  if (input.memoryBudgetTokens === 0)
    return { enabled, context: ctx, result: { ...emptyResult(ctx, profile.id), status: "ready" } };
  const capturedCredential = (
    await r.database.query(
      "SELECT credential FROM memory_registry.profiles WHERE id=$1",
      [profile.id],
    )
  ).rows[0]?.credential;
  const embedding = createEmbeddingClient(
    profile,
    await r.profiles.getCredential(ctx.ownerUserId, profile.id),
  );
  const settled = settledPairs(ctx);
  let snapshot = await loadSessionSnapshot(
    r.database,
    profile,
    ctx.sessionId,
    settled,
    ctx.messages,
    r.key,
    {
      worldHash: ctx.worldHash,
      group: ctx.mode === "group",
      minimumEpoch: ctx.resetEpoch,
    },
  );
  const temp = snapshotSessionId();
  const temporaryCtx = { ...ctx, sessionId: temp };
  const scope = scopeFor(profile, temporaryCtx);
  await ensureIdentity(r.database, scope);
  const canonicalIds = new Map<string, string>();
  try {
    if (snapshot && snapshot.pairs >= ctx.frontier) {
      const hashes = new Set(
        (
          await r.database.query<{ fact_hash: string }>(
            `SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2`,
            [profile.id, ctx.sessionId],
          )
        ).rows.map((row) => row.fact_hash),
      );
      const data = filterForgottenSnapshot(snapshot.data, hashes, r.key);
      await prepareSnapshotVectors(
        data,
        profile,
        snapshot.profileId,
        r.key,
        embedding,
      );
      const remapped = remapSnapshot(data, temp);
      for (const table of CANONICAL_TABLES)
        for (let i = 0; i < data[table].length; i++) {
          const originalId = data[table][i]?.id;
          const temporaryId = remapped[table][i]?.id;
          if (typeof originalId === "string" && typeof temporaryId === "string")
            canonicalIds.set(temporaryId, originalId);
        }
      await restoreDerived(r.database, profile, scope, remapped);
    }
    const { createMemoryRepositories } =
      await import("./repositories/index.js");
    const { createMemoryService } = await import("./service.js");
    const repositories = createMemoryRepositories(r.database, scope, r.key);
    const lore = await repositories.lore.listForCharacter(false);
    const characterIds = input.characterEntryIds ? new Set(input.characterEntryIds.map(id => `${ctx.worldId}:${id}`)) : undefined;
    const authoredLore = ctx.loreEntries.filter(e => e.category !== "character" || !characterIds || characterIds.has(e.id));
    const currentLore = lore.filter((e) =>
      authoredLore.some(
        (authored) =>
          authored.id === e.id &&
          authored.content === e.content &&
          authored.name === e.name &&
          JSON.stringify(authored.metadata ?? {}) ===
            JSON.stringify(e.metadata ?? {}) &&
          JSON.stringify(authored.keys ?? []) ===
            JSON.stringify(e.keys ?? []) &&
          JSON.stringify(authored.require_keys ?? []) ===
            JSON.stringify(e.require_keys ?? []) &&
          JSON.stringify(authored.exclude_keys ?? []) ===
            JSON.stringify(e.exclude_keys ?? []) &&
          !!authored.hidden === e.hidden &&
          !!authored.always === e.always,
      ),
    );
    // Keyword recall reads the current authored biography until the background
    // index catches up. Outdated vectors remain excluded from semantic recall.
    const currentIds = new Set(currentLore.map(e => e.id));
    currentLore.push(...authoredLore.filter(e => e.category === "character" && !currentIds.has(e.id)) as typeof currentLore);
    // Only up-to-date stored rows can expose vectors or chunks. Fresh authored
    // fallbacks share IDs with old rows but must never authorize that old index.
    const eligibleIds = new Set(currentIds);
    let keyword = retrieveKeywordLore(
      currentLore.filter((e) => !e.hidden),
      ctx.query,
      ctx.messages
        .slice(-4)
        .map((m) => m.content)
        .join("\n"),
    );
    // Name/alias and positive role fields are candidates BEFORE the semantic
    // cap. Recursive mentions of other biographies cannot select the cast.
    const characters = currentLore.filter(e => e.category === "character" && !e.hidden);
    const needed = new Set(keyword.filter(e => e.category === "character" && e.query_matched).map(e => e.id));
    if (!explicitlyEmptyCharacterScene(ctx.query)) {
      for (const entry of identityRoleMatches(characters, ctx.query)) needed.add(entry.id);
    } else needed.clear();
    keyword = keyword.filter(e => e.category !== "character" || needed.has(e.id));
    const keywordIds = new Set(keyword.map(e => e.id));
    keyword.push(...characters.filter(e => needed.has(e.id) && !keywordIds.has(e.id)).map(e => ({ ...e, query_matched: true })));
    if (!requestsCharacterLookup(ctx.query)) {
      for (const entry of characters) if (!needed.has(entry.id)) eligibleIds.delete(entry.id);
    }
    const sessionLimit = memoryRecallBudgetSchema.safeParse(ctx.settings.memoryBudgetTokens);
    const accountLimit = memoryRecallBudgetSchema.safeParse(ctx.accountMemoryBudgetTokens);
    const explicitLimit = sessionLimit.success ? sessionLimit.data : accountLimit.success ? accountLimit.data : Infinity;
    const requestBudget = input.memoryBudgetTokens === undefined
      ? resolveMemoryRecallBudget(ctx.settings.memoryBudgetTokens, ctx.defaultMemoryBudgetTokens)
      : Math.min(input.memoryBudgetTokens, explicitLimit);
    const result = await createMemoryService({
      repositories: visibleLoreRepositories(repositories, eligibleIds),
      embedding,
      model: {
        complete: async () => {
          throw new Error("Retrieval never invokes a model");
        },
      },
      config: ctx.settings as never,
      ensureCurrent: async () => ensureStoryhavenSnapshotCurrent(ctx),
    }).retrieveBlock({
      ...temporaryCtx,
      loreEntries: keyword,
      loreWardrobeValues: input.loreWardrobeValues,
      memoryBudgetTokens: requestBudget,
      ...(input.memoryBudgetTokens !== undefined ? { promptTokenCounter: (text: string) => estimateTokens(text, input.model ?? ctx.model) } : {}),
    });
    const active = (
      await r.database.query(
        "SELECT id,credential FROM memory_registry.profiles WHERE user_id=$1 AND active",
        [ctx.ownerUserId],
      )
    ).rows[0];
    if (
      !(await ensureStoryhavenSnapshotCurrent(ctx)) ||
      active?.id !== profile.id ||
      active.credential !== capturedCredential
    )
      return { enabled, context: ctx, result: emptyResult(ctx, profile.id) };
    return {
      enabled,
      context: ctx,
      result: {
        ...result,
        usedIds: result.usedIds.map((id) => canonicalIds.get(id) ?? id),
        droppedIds: result.droppedIds.map((id) => canonicalIds.get(id) ?? id),
        epoch: ctx.epoch,
        sourceHash: ctx.sourceHash,
        status: "ready",
      },
    };
  } finally {
    await purgeDerived(r.database, profile, temp);
  }
}

export async function scheduleStoryhavenMemory(
  sessionId: string,
  actingUserId: string,
  model?: string,
): Promise<void> {
  if (stopped) return;
  const own = (
    await db.execute(
      sql`SELECT user_id FROM play_sessions WHERE id=${sessionId}`,
    )
  ).rows[0];
  if (!own) return;
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: String(own.user_id),
    actingUserId,
    sessionId,
    model,
  });
  if (!(await storyhavenBackendEnabled(ctx))) return;
  if (stopped) return;
  const r = await getMemoryRuntime(),
    profile = await r.profiles.getActive(ctx.ownerUserId);
  if (!profile) return;
  if (stopped) return;
  if (!(await r.jobs.syncEpoch(profile.id, sessionId, ctx.epoch))) return;
  await r.jobs.enqueue({
    profileId: profile.id,
    sessionId,
    epoch: ctx.epoch,
    sourceHash: ctx.sourceHash,
    kind: "extract",
    payload: { actingUserId, model: ctx.model },
  });
  if (!(await ensureStoryhavenSnapshotCurrent(ctx))) return;
  await db.execute(
    sql`UPDATE storyhaven_memory_sessions SET status='pending',error_code=NULL,source_hash=${ctx.sourceHash} WHERE session_id=${sessionId} AND epoch=${ctx.epoch}`,
  );
  wakeMemoryWorker();
}

async function runJob(claim: MemoryJobClaim): Promise<void> {
  const r = await getMemoryRuntime();
  const p = (
    await r.database.query<{ user_id: string }>(
      "SELECT user_id FROM memory_registry.profiles WHERE id=$1",
      [claim.profileId],
    )
  ).rows[0];
  if (!p) return;
  // Resolve inheritance before capturing ciphertext. Jobs still belong to the
  // recipient profile and may not run after a personal profile switch.
  const profile = await r.profiles.getActive(p.user_id);
  if (!profile || profile.id !== claim.profileId || profile.status !== "ready")
    throw new Error("memory_profile_changed");
  const ctx = await loadStoryhavenTurnContext({
    ownerUserId: p.user_id,
    actingUserId: String(claim.payload.actingUserId ?? p.user_id),
    sessionId: claim.sessionId,
  });
  if (ctx.epoch !== claim.epoch || ctx.sourceHash !== claim.sourceHash)
    throw new Error("memory_stale_claim");
  await materializePendingMemoryFork(ctx.ownerUserId, ctx.sessionId);
  const credential = (
    await r.database.query<{ credential: string | null }>(
      "SELECT credential FROM memory_registry.profiles WHERE id=$1",
      [profile.id],
    )
  ).rows[0]?.credential;
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setInterval(() => {
    r.jobs
      .heartbeat(claim)
      .then((ok) => {
        if (!ok) controller.abort();
      })
      .catch(() => controller.abort());
  }, 30_000);
  timer.unref();
  const guarded: MemoryDatabase = {
    query: (q, v) => r.database.query(q, v),
    close: async () => {},
    transaction: (work) =>
      db.transaction(async (appTx) => {
        const current = (
          await appTx.execute(
            sql`SELECT m.epoch,s.user_id FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE s.id=${ctx.sessionId} AND s.user_id=${ctx.ownerUserId} FOR UPDATE OF m,s`,
          )
        ).rows[0];
        if (Number(current?.epoch) !== ctx.epoch || controller.signal.aborted)
          throw new Error("memory_stale_claim");
        return r.database.transaction(async (tx) => {
          await r.jobs.assertClaim(tx, claim);
          const pointer = (
            await tx.query(
              "SELECT id,credential FROM memory_registry.profiles WHERE user_id=$1 AND active FOR SHARE",
              [ctx.ownerUserId],
            )
          ).rows[0];
          if (pointer?.id !== profile.id || pointer.credential !== credential)
            throw new Error("memory_profile_changed");
          return work(tx);
        });
      }),
  };
  try {
    const scope = scopeFor(profile, ctx);
    await ensureIdentity(guarded, scope);
    const { createMemoryRepositories } =
      await import("./repositories/index.js");
    const { createMemoryService } = await import("./service.js");
    const repositories = createMemoryRepositories(guarded, scope, r.key);
    const embedding = createEmbeddingClient(
      profile,
      await r.profiles.getCredential(ctx.ownerUserId, profile.id),
    );
    const model = await createMemoryModel(
      ctx.actingUserId,
      ctx.sessionId,
      ctx.model,
      ctx.modelProfileId,
    );
    await reconcileAuthoredLore({
      repositories,
      embedding,
      model,
      entries: ctx.loreEntries as AuthoredLoreEntry[],
      worldId: ctx.worldId,
      signal: controller.signal,
    });
    const settled = settledPairs(ctx);
    let snapshot = await loadSessionSnapshot(
      r.database,
      profile,
      ctx.sessionId,
      settled,
      ctx.messages,
      r.key,
      {
        worldHash: ctx.worldHash,
        group: ctx.mode === "group",
        minimumEpoch: ctx.resetEpoch,
      },
    );
    const hashes = new Set(
      (
        await r.database.query<{ fact_hash: string }>(
          `SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2`,
          [profile.id, ctx.sessionId],
        )
      ).rows.map((row) => row.fact_hash),
    );
    if (snapshot && snapshot.pairs >= ctx.frontier) {
      const data = filterForgottenSnapshot(snapshot.data, hashes, r.key);
      await prepareSnapshotVectors(
        data,
        profile,
        snapshot.profileId,
        r.key,
        embedding,
      );
      await guarded.transaction((tx) =>
        restoreDerived(tx, profile, scope, remapSnapshot(data, ctx.sessionId)),
      );
    } else {
      await guarded.transaction(async (tx) => {
        await purgeDerived(tx, profile, ctx.sessionId);
        await ensureIdentity(tx, scope);
        await createMemoryRepositories(tx, scope, r.key).facts.setCursor(
          Math.min(ctx.frontier, settled),
        );
      });
    }
    const service = createMemoryService({
      repositories,
      embedding,
      model,
      config: ctx.settings as never,
      ensureCurrent: () => ensureStoryhavenSnapshotCurrent(ctx),
      onBatchCommit: async (batch, write) =>
        guarded.transaction(async (tx) => {
          const bound = createMemoryRepositories(tx, scope, r.key);
          await write(bound);
          for (const fact of await bound.facts.listLive(100000))
            if (
              hashes.has(
                (await import("./snapshots.js")).factForgetHash(fact.text),
              )
            )
              await bound.facts.deleteFact(fact.id);
          // Accepted cursor/fact progress survives a crash before the next
          // clustering call, matching source resumption without re-extraction.
          await saveSessionSnapshot(
            tx,
            profile,
            ctx.sessionId,
            batch.pairEnd,
            ctx.messages,
            r.key,
            {
              worldHash: ctx.worldHash,
              group: ctx.mode === "group",
              epoch: ctx.epoch,
            },
          );
        }),
      onBatchCommitted: (batch) =>
        guarded.transaction((tx) =>
          saveSessionSnapshot(
            tx,
            profile,
            ctx.sessionId,
            batch.pairEnd,
            ctx.messages,
            r.key,
            {
              worldHash: ctx.worldHash,
              group: ctx.mode === "group",
              epoch: ctx.epoch,
            },
          ),
        ),
    });
    await service.extractSettled({ ...ctx, signal: controller.signal });
    if (await r.jobs.finish(claim))
      await db.execute(
        sql`UPDATE storyhaven_memory_sessions SET status='ready',error_code=NULL WHERE session_id=${ctx.sessionId} AND epoch=${ctx.epoch} AND source_hash=${ctx.sourceHash}`,
      );
  } finally {
    clearInterval(timer);
    activeControllers.delete(controller);
  }
}

let polling: ReturnType<typeof setInterval> | undefined;
let stopped = true;
let draining: Promise<void> | undefined;
const activeControllers = new Set<AbortController>();
export function wakeMemoryWorker(): void {
  if (!stopped)
    queueMicrotask(() => {
      void drainMemoryWork().catch(() => {});
    });
}
export function startMemoryWorker(): void {
  stopped = false;
  if (!polling) {
    polling = setInterval(wakeMemoryWorker, 5000);
    polling.unref();
    wakeMemoryWorker();
  }
}
export async function stopMemoryWorker(): Promise<void> {
  stopped = true;
  if (polling) clearInterval(polling);
  polling = undefined;
  for (const controller of activeControllers) controller.abort();
  await draining;
}
export function drainMemoryWork(): Promise<void> {
  return (draining ??= performDrain().finally(() => {
    draining = undefined;
  }));
}
async function performDrain(): Promise<void> {
  const r = await getMemoryRuntime();
  const forks = (
    await db.execute(
      sql`SELECT DISTINCT owner_user_id,session_id FROM storyhaven_memory_outbox WHERE kind='fork' AND delivered_at IS NULL`,
    )
  ).rows;
  for (const fork of forks)
    await materializePendingMemoryFork(
      String(fork.owner_user_id),
      String(fork.session_id),
    );
  const events = (
    await db.execute(
      sql`SELECT * FROM storyhaven_memory_outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 200`,
    )
  ).rows;
  const grouped = new Map<string, (typeof events)[number]>();
  // Frozen forks are delivered above, independent of the bounded append window.
  const pendingForks = new Set(
    (
      await db.execute(
        sql`SELECT session_id FROM storyhaven_memory_outbox WHERE kind='fork' AND delivered_at IS NULL`,
      )
    ).rows.map((row) => String(row.session_id)),
  );
  for (const event of events)
    if (event.kind !== "fork" && !pendingForks.has(String(event.session_id)))
      grouped.set(String(event.session_id), event);
  for (const event of grouped.values()) {
    const owner = String(event.owner_user_id),
      sessionId = String(event.session_id);
    if (event.kind === "purge-owner") {
      if (
        !(await db.execute(sql`SELECT id FROM "user" WHERE id=${owner}`)).rows
          .length
      ) {
        await r.database.transaction(async (tx) => {
          await tx.query(
            "SELECT e.profile_id,e.session_id FROM memory_session_epochs e JOIN memory_registry.profiles p ON p.id=e.profile_id WHERE p.user_id=$1 ORDER BY e.profile_id,e.session_id FOR UPDATE OF e",
            [owner],
          );
          await tx.query(
            "INSERT INTO memory_registry.profile_owners(user_id,next_revision) VALUES($1,0) ON CONFLICT DO NOTHING",
            [owner],
          );
          await tx.query(
            "SELECT user_id FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE",
            [owner],
          );
          for (const profile of (
            await tx.query(
              "SELECT id,schema_name FROM memory_registry.profiles WHERE user_id=$1 FOR UPDATE",
              [owner],
            )
          ).rows) {
            await tx.query(
              "UPDATE memory_jobs SET status='cancelled',generation=generation+1,token=NULL,lease_until=NULL WHERE profile_id=$1",
              [profile.id],
            );
            await tx.query(
              `DROP SCHEMA IF EXISTS ${quoteSchema(String(profile.schema_name))} CASCADE`,
            );
            for (const table of [
              "memory_snapshots",
              "memory_forget_ledger",
              "memory_jobs",
              "memory_session_epochs",
            ])
              await tx.query(`DELETE FROM ${table} WHERE profile_id=$1`, [
                profile.id,
              ]);
          }
          if (
            (
              await tx.query(
                "SELECT to_regclass('memory_registry.model_invocations') AS name",
              )
            ).rows[0]?.name
          )
            await tx.query(
              "DELETE FROM memory_registry.model_invocations WHERE user_id=$1",
              [owner],
            );
          if (
            (
              await tx.query(
                "SELECT to_regclass('memory_registry.profile_reindex_attempts') AS name",
              )
            ).rows[0]?.name
          )
            await tx.query(
              "DELETE FROM memory_registry.profile_reindex_attempts WHERE user_id=$1",
              [owner],
            );
          await tx.query(
            "DELETE FROM memory_registry.profiles WHERE user_id=$1",
            [owner],
          );
          await tx.query(
            "UPDATE memory_registry.profile_owners SET deleted=true WHERE user_id=$1",
            [owner],
          );
        });
        // Frozen checkpoints contain encrypted canonical data. Remove them only
        // after memory cleanup commits and releases its locks, allowing retries.
        await db.execute(
          sql`DELETE FROM storyhaven_memory_outbox WHERE owner_user_id=${owner}`,
        );
      }
    } else if (event.kind === "purge-world") {
      const worldId = String(
        (event.payload as Record<string, unknown>).worldId,
      );
      if (
        !(await db.execute(sql`SELECT id FROM worlds WHERE id=${worldId}`)).rows
          .length
      )
        for (const profile of await r.profiles.list(owner)) {
          const s = quoteSchema(profile.schemaName);
          await r.database.transaction(async (tx) => {
            await tx.query(
              "SELECT profile_id,session_id FROM memory_session_epochs WHERE profile_id=$1 ORDER BY session_id FOR UPDATE",
              [profile.id],
            );
            if (
              !(
                await tx.query(
                  "SELECT id FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 FOR SHARE",
                  [profile.id, owner],
                )
              ).rows.length
            )
              return;
            const ids = (
              await tx.query(
                `SELECT id FROM ${s}.lore WHERE char_id=$1 AND owner_id=$2`,
                [worldId, owner],
              )
            ).rows.map((row) => String(row.id));
            await tx.query(
              `DELETE FROM ${s}.lore_links WHERE lore_id_a=ANY($1::text[]) OR lore_id_b=ANY($1::text[])`,
              [ids],
            );
            await tx.query(
              `DELETE FROM ${s}.secret_vectors WHERE lore_id=ANY($1::text[])`,
              [ids],
            );
            await tx.query(
              `DELETE FROM ${s}.lore_vectors WHERE lore_id=ANY($1::text[])`,
              [ids],
            );
            await tx.query(`DELETE FROM ${s}.lore WHERE id=ANY($1::text[])`, [
              ids,
            ]);
            for (const row of (
              await tx.query(`SELECT id FROM ${s}.sessions WHERE char_id=$1`, [
                worldId,
              ])
            ).rows)
              await purgeDerived(tx, profile, String(row.id));
            await tx.query(
              `DELETE FROM ${s}.characters WHERE id=$1 AND owner_id=$2`,
              [worldId, owner],
            );
          });
        }
    } else {
      const exists =
        (
          await db.execute(
            sql`SELECT id FROM play_sessions WHERE id=${sessionId} AND user_id=${owner}`,
          )
        ).rows.length > 0;
      for (const profile of await r.profiles.list(owner)) {
        if (!exists) {
          await r.jobs.syncEpoch(
            profile.id,
            sessionId,
            Number(event.epoch),
            true,
          );
          await r.database.transaction(async (tx) => {
            await tx.query(
              "SELECT profile_id,session_id FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2 FOR UPDATE",
              [profile.id, sessionId],
            );
            if (
              !(
                await tx.query(
                  "SELECT id FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 FOR SHARE",
                  [profile.id, owner],
                )
              ).rows.length
            )
              return;
            await tx.query(
              "UPDATE memory_jobs SET status='cancelled',generation=generation+1,token=NULL,lease_until=NULL WHERE profile_id=$1 AND session_id=$2",
              [profile.id, sessionId],
            );
            await purgeDerived(tx, profile, sessionId);
            await tx.query(
              "DELETE FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
              [profile.id, sessionId],
            );
            await tx.query(
              "DELETE FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
              [profile.id, sessionId],
            );
          });
        } else
          await r.jobs.syncEpoch(profile.id, sessionId, Number(event.epoch));
      }
      if (!exists)
        await db.execute(
          sql`DELETE FROM storyhaven_memory_outbox WHERE owner_user_id=${owner} AND session_id=${sessionId}`,
        );
      if (exists && (event.kind === "clear" || event.kind === "rebuild")) {
        const ctx = await loadStoryhavenTurnContext({
          ownerUserId: owner,
          actingUserId: owner,
          sessionId,
        });
        if (ctx.epoch === Number(event.epoch)) {
          const profile = await r.profiles.getActive(owner);
          if (profile)
            await db.transaction(async (appTx) => {
              const row = (
                await appTx.execute(
                  sql`SELECT epoch FROM storyhaven_memory_sessions WHERE session_id=${sessionId} FOR UPDATE`,
                )
              ).rows[0];
              if (Number(row?.epoch) !== ctx.epoch) return;
              await r.database.transaction(async (tx) => {
                await tx.query(
                  "SELECT profile_id,session_id FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2 FOR UPDATE",
                  [profile.id, sessionId],
                );
                if (
                  !(
                    await tx.query(
                      "SELECT id FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 AND active FOR SHARE",
                      [profile.id, owner],
                    )
                  ).rows.length
                )
                  return;
                await purgeDerived(tx, profile, sessionId);
                await ensureIdentity(tx, scopeFor(profile, ctx));
                await tx.query(
                  "DELETE FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
                  [profile.id, sessionId],
                );
                const { createMemoryRepositories } =
                  await import("./repositories/index.js");
                await createMemoryRepositories(
                  tx,
                  scopeFor(profile, ctx),
                  r.key,
                ).facts.setCursor(ctx.frontier);
                await saveSessionSnapshot(
                  tx,
                  profile,
                  sessionId,
                  ctx.frontier,
                  ctx.messages,
                  r.key,
                  {
                    worldHash: ctx.worldHash,
                    group: ctx.mode === "group",
                    epoch: ctx.epoch,
                  },
                );
              });
            });
        }
      }
      if (exists && event.kind !== "manual" && event.kind !== "clear")
        await scheduleStoryhavenMemory(sessionId, owner);
    }
    await db.execute(
      sql`UPDATE storyhaven_memory_outbox SET delivered_at=NOW() WHERE session_id=${sessionId} AND id<=${Number(event.id)}`,
    );
  }
  let claim: MemoryJobClaim | null;
  while (!stopped && (claim = await r.jobs.claim())) {
    try {
      await runJob(claim);
    } catch (error) {
      const code =
        error instanceof Error && error.message === "memory_model_unavailable"
          ? "memory_model_unavailable"
          : "memory_update_failed";
      if (await r.jobs.fail(claim, code))
        await db.execute(
          sql`UPDATE storyhaven_memory_sessions SET status='failed',error_code=${code} WHERE session_id=${claim.sessionId} AND epoch=${claim.epoch} AND source_hash=${claim.sourceHash}`,
        );
    }
  }
}
