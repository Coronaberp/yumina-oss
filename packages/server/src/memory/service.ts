import { randomUUID } from "node:crypto";
import * as defaults from "./config.js";
import { runExtract, runReconcile } from "./extraction.js";
import { buildBlock, buildPromptBlock, renderFact } from "./block.js";
import {
  rank,
  rankClusters,
  isActive,
  participantsPresent,
  type CoreFact,
} from "./ranking.js";
import {
  exchanges,
  currentTurn,
  userTurnOrdinals,
  presentParticipants,
  recentText,
  transcript,
} from "./retrieval.js";
import {
  createLoreService,
  type PreparedLoreUpdate,
  type PreparedSecretReveal,
} from "./lore.js";
import { createClusterService, pythonSortedStrings } from "./clusters.js";
import type {
  EmbeddingClient,
  FactDraft,
  MemoryModel,
  MemoryResult,
  TurnMemoryContext,
} from "./types.js";
import type { MemoryRepositories, InsertFact } from "./repositories/index.js";
export interface MemoryServiceContext extends TurnMemoryContext {
  namesById?: Record<string, string>;
  userNamesBySenderId?: Record<string, string>;
  applyGlobalLore?: boolean;
  memoryBudgetTokens?: number;
  /** Present only when recall is being packed into a complete story request. */
  promptTokenCounter?: (text: string) => number;
  loreMaxDist?: number;
  signal?: AbortSignal;
}
export interface MemoryBatchCommit {
  id: string;
  pairStart: number;
  pairEnd: number;
  turn: number;
  phase: "facts" | "clusters" | "rollback";
  messageIds: string[];
  ctx: MemoryServiceContext;
}
export interface MemoryServiceConfig extends defaults.MemoryAlgorithmConfig {
  batchSize?: number;
  settleMarginExchanges?: number;
  catchupMinPairs?: number;
  sessionNeighborK?: number;
  sessionCandidateK?: number;
  maxActiveReservedFacts?: number;
  maxPinnedLoreChunks?: number;
  clusterTriggerCount?: number;
  clusterMultiThread?: boolean;
  clusterMaxSummaries?: number;
  memoryBudgetTokens?: number;
  loreMaxDist?: number;
}
export interface MemoryServiceDependencies {
  repositories: MemoryRepositories;
  embedding: EmbeddingClient;
  model: MemoryModel;
  config?: MemoryServiceConfig;
  /** Executes the write against freshly bound repositories in a short fenced transaction. */
  onBatchCommit?: (
    batch: MemoryBatchCommit,
    write: (repositories: MemoryRepositories) => Promise<void>,
  ) => Promise<void>;
  /** Snapshot accepted state only after clustering has finished. */
  onBatchCommitted?: (batch: MemoryBatchCommit) => Promise<void>;
  ensureCurrent?: (ctx: MemoryServiceContext) => Promise<boolean>;
}
export interface BatchExtractionStats {
  facts: number;
  added: number;
  reinforced: number;
  superseded: number;
  lore_updates_applied: number;
  secrets_revealed: number;
}
interface PreparedBatch {
  drafts: FactDraft[];
  vectors: number[][];
  decisions: Awaited<ReturnType<typeof runReconcile>>;
  scene: { doing: string; location: string; npcs: string[] };
  lore: PreparedLoreUpdate[];
  reveals: PreparedSecretReveal[];
}
/** Source flow with explicit scoped repositories and adapter-owned acceptance fencing. */
export function createMemoryService(deps: MemoryServiceDependencies) {
  const { repositories, embedding, model } = deps,
    cfg = { ...deps.config };
  const batchSize = cfg.batchSize ?? defaults.BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Invalid memory extraction batch size");
  const scope = { ...repositories.facts.context.scope };
  let extractionTail: Promise<unknown> = Promise.resolve();
  async function assertCurrent(ctx: MemoryServiceContext) {
    if (
      ctx.ownerUserId !== scope.ownerUserId ||
      ctx.sessionId !== scope.sessionId
    )
      throw new Error("Memory context scope mismatch");
    if (ctx.signal?.aborted) throw new Error("Memory operation cancelled");
    if (deps.ensureCurrent && !(await deps.ensureCurrent(ctx)))
      throw new Error("Memory source changed");
  }
  function loreFor(ctx: MemoryServiceContext, repos = repositories) {
    return createLoreService({
      repositories: repos,
      embedding,
      model,
      charId: scope.charId,
      loreMaxDist: ctx.loreMaxDist ?? cfg.loreMaxDist,
      maxPinnedChunks: cfg.maxPinnedLoreChunks,
      loreNeighborK: cfg.loreNeighborK,
      loreCandidateK: cfg.loreCandidateK,
      includeCharacterIdentity: Boolean(ctx.promptTokenCounter),
      maxSemanticCharacters: ctx.promptTokenCounter ? 4 : undefined,
      signal: ctx.signal,
    });
  }
  function clustersFor(ctx: MemoryServiceContext, repos = repositories) {
    return createClusterService({
      repositories: repos,
      embedding,
      model,
      triggerCount: cfg.clusterTriggerCount,
      signal: ctx.signal,
    });
  }
  async function commit(
    batch: MemoryBatchCommit,
    write: (repos: MemoryRepositories) => Promise<void>,
  ) {
    await assertCurrent(batch.ctx);
    if (deps.onBatchCommit) await deps.onBatchCommit(batch, write);
    else await write(repositories);
  }
  async function prepareBatch(
    ctx: MemoryServiceContext,
    pairs: ReturnType<typeof exchanges>,
    previousScene: { doing: string; location: string; npcs: string[] },
  ): Promise<PreparedBatch> {
    const [drafts, state] = await runExtract(
      transcript(
        pairs,
        ctx.charName,
        ctx.userName,
        ctx.namesById,
        ctx.userNamesBySenderId,
      ),
      ctx.charName,
      ctx.userName,
      ctx.language,
      model,
      ctx.castNames,
      ctx.signal,
      {maxFactsPerBatch: cfg.maxFactsPerBatch},
    );
    const scene = {
      doing: state.doing || previousScene.doing,
      location: state.location || previousScene.location,
      npcs: pythonSortedStrings([...previousScene.npcs, ...state.npcs]),
    };
    const vectors: number[][] = [],
      neighbors: CoreFact[][] = [];
    for (const draft of drafts) {
      const vec = await embedding.embed(draft.text, ctx.signal);
      vectors.push(vec);
      neighbors.push(
        await repositories.facts.similarCurrent(
          vec,
          cfg.sessionNeighborK ?? defaults.SESSION_NEIGHBOR_K,
        ),
      );
    }
    const decisions = await runReconcile(drafts, neighbors, model, ctx.signal);
    const loreService = loreFor(ctx);
    const lore = await loreService.prepareLoreUpdates(drafts);
    const reveals = await loreService.prepareSecretReveals(drafts);
    return { drafts, vectors, decisions, scene, lore, reveals };
  }
  async function commitBatch(
    ctx: MemoryServiceContext,
    batch: MemoryBatchCommit,
    prepared: PreparedBatch,
  ): Promise<BatchExtractionStats> {
    const stats: BatchExtractionStats = {
      facts: prepared.drafts.length,
      added: 0,
      reinforced: 0,
      superseded: 0,
      lore_updates_applied: 0,
      secrets_revealed: 0,
    };
    await commit(batch, async (repos) => {
      // Source scene update failures are tolerated; all other fact writes remain authoritative.
      try {
        await repos.facts.setSceneState(
          prepared.scene.doing,
          prepared.scene.location,
          prepared.scene.npcs,
        );
      } catch {}
      for (const decision of prepared.decisions) {
        const draft = prepared.drafts[decision.index]!,
          vec = prepared.vectors[decision.index]!;
        const participants =
          draft.fact_type !== "world" && !draft.participants.length
            ? [
                ctx.userName,
                ...(ctx.castNames.length ? ctx.castNames : [ctx.charName]),
              ]
            : [...draft.participants];
        const fact: InsertFact = {
          ...draft,
          participants,
          turn: batch.turn,
          location: prepared.scene.location,
          batch_id: batch.id,
        };
        if (decision.action === "add") {
          await repos.facts.insert(fact, vec);
          stats.added++;
        } else if (decision.action === "reinforce") {
          await repos.facts.reinforce(
            decision.target_id!,
            batch.turn,
            batch.id,
          );
          stats.reinforced++;
        } else {
          await repos.facts.supersede(
            decision.target_id!,
            fact,
            vec,
            batch.turn,
          );
          stats.superseded++;
        }
      }
      const lore = loreFor(ctx, repos);
      stats.lore_updates_applied = await lore.commitLoreUpdates(
        prepared.lore,
        batch.id,
        repos,
      );
      stats.secrets_revealed = await lore.commitSecretReveals(
        prepared.reveals,
        batch.id,
        repos,
      );
      await repos.facts.recordBatch(
        batch.id,
        batch.pairStart,
        batch.pairEnd,
        batch.turn,
      );
      await repos.facts.setCursor(batch.pairEnd);
    });
    return stats;
  }
  async function buildReadyClusters(
    ctx: MemoryServiceContext,
    batch: MemoryBatchCommit,
  ): Promise<void> {
    const clusters = clustersFor(ctx),
      meta = { ...batch, phase: "clusters" as const };
    if (cfg.clusterMultiThread ?? defaults.CLUSTER_MULTI_THREAD) {
      const facts = await clusters.shouldBuildClusterMulti();
      if (facts.length) {
        const prepared = await clusters.prepareAssignments(facts);
        await commit(meta, async (repos) => {
          await clusters.commitAssignments(prepared, repos);
        });
      }
    } else {
      const latest = await repositories.clusters.latestForSession(),
        since = latest?.source_batch_ids.at(-1) ?? null;
      if (await clusters.shouldBuildCluster(since)) {
        const facts = await repositories.facts.factsSinceBatch(since),
          batchIds = await repositories.facts.batchIdsSince(since);
        const prepared = await clusters.prepareCluster(
          facts,
          batchIds,
          latest?.summary_text,
        );
        await commit(meta, async (repos) => {
          await clusters.commitCluster(prepared, repos);
        });
      }
    }
  }
  async function extractSettledInner(
    ctx: MemoryServiceContext,
  ): Promise<BatchExtractionStats[]> {
    await assertCurrent(ctx);
    const pairs = exchanges(
      ctx.messages,
      ctx.mode === "group" || !!Object.keys(ctx.namesById ?? {}).length,
    );
    const settled = Math.max(
      0,
      pairs.length -
        (cfg.settleMarginExchanges ?? defaults.SETTLE_MARGIN_EXCHANGES),
    );
    let cursor = await repositories.facts.getCursor();
    const ordinals = userTurnOrdinals(ctx.messages),
      existingIds = new Set(ctx.messages.map((m) => m.id));
    // Like source service.py, this caller's scene snapshot is used across catch-up batches.
    const previousScene = await repositories.facts.getSceneState();
    const stats: BatchExtractionStats[] = [];
    async function process(start: number, end: number) {
      const selected = pairs.slice(start, end),
        messageIds = [
          ...new Set(selected.flatMap((pair) => pair.map((m) => m.id!))),
        ];
      if (messageIds.some((id) => !existingIds.has(id))) return false;
      const turn = ordinals[selected.at(-1)![0].id!]!;
      const batch: MemoryBatchCommit = {
        id: `mebatch_${randomUUID().replaceAll("-", "")}`,
        pairStart: start,
        pairEnd: end,
        turn,
        phase: "facts",
        messageIds,
        ctx,
      };
      const prepared = await prepareBatch(ctx, selected, previousScene);
      stats.push(await commitBatch(ctx, batch, prepared));
      await buildReadyClusters(ctx, batch);
      await assertCurrent(ctx);
      await deps.onBatchCommitted?.(batch);
      return true;
    }
    const size = cfg.batchSize ?? defaults.BATCH_SIZE;
    while (settled - cursor >= size) {
      if (!(await process(cursor, cursor + size))) return stats;
      cursor += size;
    }
    if (
      pairs.length >= (cfg.catchupMinPairs ?? defaults.CATCHUP_MIN_PAIRS) &&
      settled - cursor >= 1
    )
      await process(cursor, settled);
    return stats;
  }
  function extractSettled(
    ctx: MemoryServiceContext,
  ): Promise<BatchExtractionStats[]> {
    const run = extractionTail
      .catch(() => {})
      .then(() => extractSettledInner(ctx));
    extractionTail = run;
    return run;
  }
  async function retrieveBlock(
    ctx: MemoryServiceContext,
  ): Promise<MemoryResult> {
    await assertCurrent(ctx);
    const turn = currentTurn(ctx.messages),
      scene = await repositories.facts.getSceneState();
    let queryVector: number[] | null = null,
      errorCode: string | undefined;
    if (ctx.query) {
      try {
        queryVector = await embedding.embedQuery(ctx.query, ctx.signal);
      } catch {
        errorCode = "embedding_unavailable";
      }
    }
    const lore = await loreFor(ctx).fetchCandidates(
      ctx.loreEntries,
      queryVector,
      { lore_max_dist: ctx.loreMaxDist },
      turn,
      ctx.applyGlobalLore ?? false,
    );
    const base = {
      profileId: scope.profileId,
      epoch: ctx.epoch,
      sourceHash: ctx.sourceHash,
      status: "ready" as const,
      ...(errorCode ? { errorCode } : {}),
    };
    if (!ctx.query && !lore.length) {
      await assertCurrent(ctx);
      return {
        ...base,
        block: "",
        usedIds: [],
        droppedIds: [],
        loreLines: [],
        memoryLines: [],
      };
    }
    const present = presentParticipants(
        ctx.charName,
        [ctx.userName],
        scene.npcs,
        recentText(ctx.messages),
      ),
      presentLower = new Set(present.map((p) => p.toLowerCase()));
    const candidates =
      queryVector !== null
        ? await repositories.facts.similarLive(
            queryVector,
            cfg.sessionCandidateK ?? defaults.SESSION_CANDIDATE_K,
          )
        : [];
    const guaranteed = await repositories.facts.reserved(),
      pinned = guaranteed.filter((f) => f.pinned);
    const unpinned = guaranteed.filter(
      (f) => !f.pinned && participantsPresent(f, presentLower),
    );
    const active = unpinned
      .filter((f) => isActive(f, scene.location))
      .sort((a, b) => b.importance - a.importance || b.last_turn - a.last_turn)
      .slice(
        0,
        cfg.maxActiveReservedFacts ?? defaults.MAX_ACTIVE_RESERVED_FACTS,
      );
    const activeIds = new Set(active.map((f) => f.id)),
      excluded = new Set([...activeIds, ...pinned.map((f) => f.id)]);
    const merged = new Map(
      candidates
        .filter((f) => !excluded.has(f.id))
        .map((f) => [f.id, { ...f }]),
    );
    for (const fact of unpinned.filter((f) => !activeIds.has(f.id))) {
      const existing = merged.get(fact.id);
      if (existing) existing.demoted = true;
      else
        merged.set(fact.id, {
          ...fact,
          distance: fact.distance ?? 1,
          demoted: true,
        });
    }
    const rankedMemory = rank(
      [...merged.values()],
      present,
      turn,
      scene.location,
    );
    const lorePinned = lore.filter((c) => c.pinned),
      rankedLore = rank(
        lore.filter((c) => !c.pinned),
        present,
        turn,
        scene.location,
      );
    let selectedClusters;
    if (cfg.clusterMultiThread ?? defaults.CLUSTER_MULTI_THREAD) {
      const clusters = await repositories.clusters.activeForSession();
      if (queryVector !== null && clusters.length) {
        const hits = await repositories.vectors.searchClusterIds(
            queryVector,
            clusters.length,
          ),
          distance = new Map(hits.map((h) => [h.cluster_id, h.distance]));
        for (const cluster of clusters)
          cluster.distance = distance.get(cluster.id) ?? 1;
      }
      selectedClusters = rankClusters(clusters, turn).slice(
        0,
        cfg.clusterMaxSummaries ?? defaults.CLUSTER_MAX_SUMMARIES,
      );
    } else {
      const latest = await repositories.clusters.latestForSession();
      selectedClusters = latest ? [latest] : [];
    }
    const blockArgs: [CoreFact[], CoreFact[], CoreFact[]] = [
      [...pinned, ...lorePinned],
      active,
      [...rankedMemory, ...rankedLore],
    ];
    const options = {clusterBudgetTokens:cfg.clusterBudgetTokens,reservedFraction:cfg.reservedFraction};
    const result = ctx.promptTokenCounter
      ? buildPromptBlock(...blockArgs, ctx.memoryBudgetTokens ?? cfg.memoryBudgetTokens ?? 1000, ctx.promptTokenCounter, selectedClusters, options)
      : buildBlock(...blockArgs, ctx.memoryBudgetTokens || cfg.memoryBudgetTokens || 1000, selectedClusters, options);
    const used = new Set(result.usedIds);
    await assertCurrent(ctx);
    return {
      ...base,
      ...result,
      loreLines: lore.filter((c) => used.has(c.id)).map(renderFact),
      memoryLines: [...pinned, ...active, ...rankedMemory]
        .filter((f) => used.has(f.id))
        .map(renderFact),
    };
  }
  async function rollbackDiscardedTurn(
    ctx: MemoryServiceContext,
    messageId: string,
  ) {
    await assertCurrent(ctx);
    const pairs = exchanges(
        ctx.messages,
        ctx.mode === "group" || !!Object.keys(ctx.namesById ?? {}).length,
      ),
      index = pairs.findIndex(([, assistant]) => assistant.id === messageId);
    if (index < 0) return null;
    const batches = (await repositories.facts.batches()).filter(
      (b) => b.pair_end > index,
    );
    const ids = batches.map((b) => b.id),
      prepared = await loreFor(ctx).prepareRollbackSessionLore(ids);
    const meta: MemoryBatchCommit = {
      id: `rollback_${randomUUID().replaceAll("-", "")}`,
      pairStart: index,
      pairEnd: pairs.length,
      turn: currentTurn(ctx.messages),
      phase: "rollback",
      messageIds: [messageId],
      ctx,
    };
    let result:
      | Awaited<ReturnType<typeof repositories.facts.rollbackFromPairIndex>>
      | undefined;
    let session_lore:
      | Awaited<
          ReturnType<ReturnType<typeof loreFor>["commitRollbackSessionLore"]>
        >
      | undefined;
    let clusters_deleted = 0;
    await commit(meta, async (repos) => {
      result = await repos.facts.rollbackFromPairIndex(index);
      session_lore = await loreFor(ctx, repos).commitRollbackSessionLore(
        prepared,
        repos,
      );
      clusters_deleted = await repos.clusters.deleteOverlapping(
        result.batch_ids,
      );
    });
    await assertCurrent(ctx);
    return { ...result!, session_lore: session_lore!, clusters_deleted };
  }
  /** Explicit adapter recovery for a crash after fact commit, never an automatic LLM retry. */
  async function repairClusters(
    ctx: MemoryServiceContext,
    batch: MemoryBatchCommit,
  ) {
    await assertCurrent(ctx);
    await buildReadyClusters(ctx, batch);
    await deps.onBatchCommitted?.(batch);
  }
  return {
    retrieveBlock,
    extractSettled,
    rollbackDiscardedTurn,
    repairClusters,
  };
}
