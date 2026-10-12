import {
  LORE_CANDIDATE_K,
  LORE_NEIGHBOR_K,
  MAX_PINNED_LORE_CHUNKS,
} from "./config.js";
import {
  runLoreUpdateDetection,
  runSecretRevealDetection,
  stripJsonFence,
} from "./extraction.js";
import { chunkLoreContent } from "./retrieval.js";
import { characterIdentity } from "../lib/story-character-identity.js";
import type { CoreFact } from "./ranking.js";
import type {
  EmbeddingClient,
  FactDraft,
  LoreEntry,
  MemoryModel,
} from "./types.js";
import type { MemoryRepositories, LoreState } from "./repositories/index.js";
export type SourceLoreEntry = LoreEntry & {
  importance?: number;
  query_matched?: boolean;
};
export interface LoreCandidate extends CoreFact {
  fact_type: "lore";
  source: "lore";
  pinned: boolean;
}
export interface LoreServiceDependencies {
  repositories: MemoryRepositories;
  embedding: EmbeddingClient;
  model: MemoryModel;
  charId: string | null;
  loreMaxDist?: number;
  maxPinnedChunks?: number;
  loreNeighborK?: number;
  loreCandidateK?: number;
  signal?: AbortSignal;
  includeCharacterIdentity?: boolean;
  maxSemanticCharacters?: number;
}
export interface PreparedLoreUpdate {
  loreId: string;
  content: string;
  vector: number[];
}
export interface PreparedLoreRollback {
  batchIds: string[];
  states: { state: LoreState; vector: number[] | null }[];
}
export interface PreparedSecretReveal {
  secretId: string;
  text: string;
  vector: number[] | null;
}
export function loreCandidate(
  entry: SourceLoreEntry,
  currentTurn: number,
  distance = 0,
  pinned = false,
  linkLabel: string | null = null,
  candidateId?: string,
  content?: string,
  metadata?: Record<string, unknown>,
  links?: { label: string; name: string }[],
): LoreCandidate {
  return {
    query_matched: !!entry.query_matched,
    id: candidateId || entry.id,
    source: "lore",
    fact_type: "lore",
    text: entry.category === "character"
      ? `[Character: ${entry.name}]\n${content !== undefined ? content : entry.content}`
      : content !== undefined ? content : entry.content,
    participants: [],
    importance: entry.importance ?? 3,
    valence: 0,
    reinforcements: 0,
    pinned,
    valid_until_turn: null,
    last_turn: currentTurn,
    distance,
    link_label: linkLabel,
    metadata: metadata || {},
    links: links || [],
  };
}
export function buildSecretExtractionPrompt(content: string): string {
  return (
    "You decompose hidden lore entries for a roleplay platform into a numbered list of short, independent facts, so a player can learn one without the others being revealed or implied.\n" +
    "Rules:\n" +
    "1. Each fact must stand completely on its own — a reader who only sees one fact must not be able to guess or infer any other fact.\n" +
    '2. Never combine two separate pieces of information into one fact, even if they\'re related. Example: "She secretly likes sweets but hates cake" must become TWO facts — "She has a sweet tooth" and "She dislikes cake" — never one, since knowing the first should never imply the second.\n' +
    "3. Paraphrase in your own words — do not quote more than a few consecutive words of the source directly.\n" +
    '4. Reply with ONLY a numbered list ("1. ", "2. ", ...), one fact per line, no preamble, no headers, no code fences.\n\n' +
    `Input:\n${content}`
  );
}
export function parseSecretExtraction(raw: string): string[] {
  const facts: string[] = [];
  for (let line of stripJsonFence(raw)
    .trim()
    .split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)) {
    line = line.trim();
    if (!line) continue;
    // Python isdigit accepts Unicode decimal/superscript digits as well as ASCII.
    let stripped =
      /^[\p{Nd}\u{b2}-\u{b3}\u{b9}\u{1369}-\u{1371}\u{19da}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]/u.test(
        line,
      )
        ? (line.includes(".") ? line.slice(line.indexOf(".") + 1) : line).trim()
        : line;
    stripped = stripped.replace(/^-+/, "").trim();
    if (stripped) facts.push(stripped);
  }
  return facts;
}
export function createLoreService(deps: LoreServiceDependencies) {
  const { repositories, embedding, model, charId, signal } = deps;
  const maxDist = deps.loreMaxDist ?? 0.8;
  function identityCandidate(entry: SourceLoreEntry, turn: number, pinned: boolean, distance = 0): LoreCandidate[] {
    if (!deps.includeCharacterIdentity || entry.category !== "character") return [];
    const identity = characterIdentity(entry);
    const content = identity.structured ? identity.facts : chunkLoreContent(entry.content)[0] ?? entry.content;
    return [{ ...loreCandidate(entry, turn, distance, pinned, null, `${entry.id}#identity`, content), character_identity: true }];
  }
  type Resolved = {
    metadata: Record<string, unknown>;
    links: { label: string; name: string }[];
  };
  async function resolveMetadataLinks(
    entries: SourceLoreEntry[],
  ): Promise<Map<string, Resolved>> {
    if (!entries.length) return new Map();
    const links = await repositories.lore.linksFor(entries.map((e) => e.id));
    const ids = new Set(entries.map((e) => e.id));
    const outgoing = links.filter((l) => ids.has(l.lore_id_a) && !!l.label);
    const targets = new Map(
      (
        await repositories.lore.byIds([
          ...new Set(outgoing.map((l) => l.lore_id_b)),
        ])
      ).map((e) => [e.id, e]),
    );
    return new Map(
      entries.map((e) => [
        e.id,
        {
          metadata: e.metadata || {},
          links: outgoing
            .filter((l) => l.lore_id_a === e.id && targets.has(l.lore_id_b))
            .map((l) => ({
              label: l.label,
              name: targets.get(l.lore_id_b)!.name,
            })),
        },
      ]),
    );
  }
  async function expand(
    entry: SourceLoreEntry,
    overrides: Record<string, string>,
    turn: number,
    pinned: boolean,
    distance = 0,
    label: string | null = null,
    resolved?: Resolved,
  ): Promise<LoreCandidate[]> {
    const info =
      resolved ?? (await resolveMetadataLinks([entry])).get(entry.id)!;
    const identity = identityCandidate(entry, turn, pinned, distance);
    if (identity.length && !pinned && characterIdentity(entry).structured) return identity;
    if (Object.hasOwn(overrides, entry.id))
      return [
        ...identity,
        loreCandidate(
          entry,
          turn,
          distance,
          pinned,
          label,
          undefined,
          overrides[entry.id],
          info.metadata,
          info.links,
        ),
      ];
    const storedChunks = await repositories.lore.chunksFor(entry.id);
    // A newly edited or not-yet-indexed biography still works by name immediately.
    const chunks = storedChunks.length || entry.category !== "character" ? storedChunks
      : chunkLoreContent(entry.content).map((content, part_id) => ({content, part_id}));
    if (!chunks.length)
      return [
        ...identity,
        loreCandidate(
          entry,
          turn,
          distance,
          pinned,
          label,
          undefined,
          undefined,
          info.metadata,
          info.links,
        ),
      ];
    return [...identity, ...chunks.map((chunk, i) =>
      loreCandidate(
        entry,
        turn,
        distance,
        pinned,
        label,
        `${entry.id}#${chunk.part_id}`,
        chunk.content,
        i === 0 ? info.metadata : undefined,
        i === 0 ? info.links : undefined,
      ),
    )];
  }
  async function fetchCandidates(
    keywordEntries: SourceLoreEntry[],
    queryVector: number[] | null,
    cfg: { lore_max_dist?: number },
    turn: number,
    applyGlobalLore = false,
  ): Promise<LoreCandidate[]> {
    const overrides = await repositories.lore.getAllOverridesForSession();
    const seen = new Set(keywordEntries.map((e) => e.id)),
      resolved = await resolveMetadataLinks(keywordEntries);
    const pinned: LoreCandidate[] = [];
    for (const entry of keywordEntries)
      pinned.push(
        ...(await expand(
          entry,
          overrides,
          turn,
          true,
          0,
          null,
          resolved.get(entry.id),
        )),
      );
    pinned.sort(
      (a, b) =>
        Number(b.query_matched) - Number(a.query_matched) ||
        b.importance - a.importance,
    );
    const cap = deps.maxPinnedChunks ?? MAX_PINNED_LORE_CHUNKS;
    const candidates = pinned.slice(0, cap),
      demoted = pinned.slice(cap).map((c) => ({ ...c, pinned: false }));
    if (queryVector !== null) {
      const hits = await repositories.vectors.searchLoreChunks(
        queryVector,
        deps.loreCandidateK ?? LORE_CANDIDATE_K,
        cfg.lore_max_dist ?? maxDist,
        applyGlobalLore,
      );
      // Snapshot the exclusion list before the loop; source allows several hits from one entry.
      const newHits = hits.filter((h) => !seen.has(h.lore_id));
      const entries = new Map(
        (
          await repositories.lore.byIds([
            ...new Set(newHits.map((h) => h.lore_id)),
          ])
        ).map((e) => [e.id, e]),
      );
      const semanticResolved = await resolveMetadataLinks([
        ...entries.values(),
      ]);
      const semanticCharacters = new Set<string>();
      for (const hit of newHits) {
        const entry = entries.get(hit.lore_id);
        if (!entry) continue;
        if (entry.category === "character" && !semanticCharacters.has(entry.id)) {
          if (deps.maxSemanticCharacters !== undefined && semanticCharacters.size >= deps.maxSemanticCharacters) continue;
          semanticCharacters.add(entry.id);
          candidates.push(...identityCandidate(entry, turn, false, hit.distance));
        }
        if (deps.includeCharacterIdentity && entry.category === "character" && characterIdentity(entry).structured) { seen.add(entry.id); continue; }
        const info = semanticResolved.get(entry.id)!;
        if (Object.hasOwn(overrides, entry.id))
          candidates.push(
            loreCandidate(
              entry,
              turn,
              hit.distance,
              false,
              null,
              undefined,
              overrides[entry.id],
              info.metadata,
              info.links,
            ),
          );
        else {
          const chunks = await repositories.lore.chunksFor(entry.id);
          if (!chunks.length) {
            if (hit.part_id === 0)
              candidates.push(
                loreCandidate(
                  entry,
                  turn,
                  hit.distance,
                  false,
                  null,
                  undefined,
                  undefined,
                  info.metadata,
                  info.links,
                ),
              );
          } else if (hit.part_id === 0)
            candidates.push(
              loreCandidate(
                entry,
                turn,
                hit.distance,
                false,
                null,
                `${entry.id}#0`,
                chunks[0]!.content,
                info.metadata,
                info.links,
              ),
            );
          else {
            const chunk = chunks.find((c) => c.part_id === hit.part_id);
            if (chunk)
              candidates.push(
                loreCandidate(
                  entry,
                  turn,
                  hit.distance,
                  false,
                  null,
                  `${entry.id}#${hit.part_id}`,
                  chunk.content,
                ),
              );
          }
        }
        seen.add(entry.id);
      }
    }
    candidates.push(...demoted);
    const expandIds = candidates.map((c) => c.id.split("#")[0]!);
    if (expandIds.length) {
      const links = await repositories.lore.linksFor(expandIds),
        ids = new Set(expandIds),
        labels = new Map<string, string>();
      for (const link of links)
        if (
          ids.has(link.lore_id_a) &&
          !seen.has(link.lore_id_b) &&
          !labels.has(link.lore_id_b)
        )
          labels.set(link.lore_id_b, link.label);
      for (const link of links)
        if (
          ids.has(link.lore_id_b) &&
          !seen.has(link.lore_id_a) &&
          !labels.has(link.lore_id_a)
        )
          labels.set(link.lore_id_a, link.label);
      if (labels.size) {
        const neighbors = (
          await repositories.lore.byIds([...labels.keys()])
        ).filter(
          (e) => e.char_id === charId || (applyGlobalLore && !e.char_id),
        );
        const neighborResolved = await resolveMetadataLinks(neighbors);
        for (const entry of neighbors) {
          candidates.push(
            ...(await expand(
              entry,
              overrides,
              turn,
              false,
              0,
              labels.get(entry.id) || null,
              neighborResolved.get(entry.id),
            )),
          );
          seen.add(entry.id);
        }
      }
    }
    const unique = new Map<string, LoreCandidate>();
    for (const candidate of candidates) {
      const prior = unique.get(candidate.id);
      if (!prior || (candidate.pinned && !prior.pinned))
        unique.set(candidate.id, candidate);
    }
    return [...unique.values()];
  }
  async function commitLoreOverride(
    update: PreparedLoreUpdate,
    batchId?: string | null,
    repos = repositories,
  ): Promise<string> {
    const existing = await repos.lore.getState(update.loreId);
    let factId: string;
    if (existing?.override_fact_id) {
      factId = existing.override_fact_id;
      await repos.facts.updateText(factId, update.content, update.vector);
    } else
      factId = await repos.facts.insert(
        {
          text: update.content,
          fact_type: "state",
          participants: [],
          importance: 5,
          valence: 0,
          turn: 0,
          batch_id: batchId,
        },
        update.vector,
        true,
      );
    await repos.lore.setOverride(
      update.loreId,
      update.content,
      factId,
      batchId,
    );
    return factId;
  }
  async function applySessionLoreOverride(
    loreId: string,
    content: string,
    batchId?: string | null,
  ) {
    return commitLoreOverride(
      { loreId, content, vector: await embedding.embed(content, signal) },
      batchId,
    );
  }
  async function prepareLoreUpdates(
    drafts: FactDraft[],
  ): Promise<PreparedLoreUpdate[]> {
    if (!drafts.length) return [];
    const neighbors: { id: string; text: string }[][] = [];
    for (const draft of drafts) {
      try {
        const vec = await embedding.embed(draft.text, signal),
          ids = await repositories.vectors.searchLoreIds(
            vec,
            deps.loreNeighborK ?? LORE_NEIGHBOR_K,
            maxDist,
          );
        const entries = ids.length ? await repositories.lore.byIds(ids) : [];
        neighbors.push(entries.map((e) => ({ id: e.id, text: e.content })));
      } catch {
        neighbors.push([]);
      }
    }
    const decisions = await runLoreUpdateDetection(
        drafts,
        neighbors,
        model,
        signal,
      ),
      prepared: PreparedLoreUpdate[] = [];
    for (const d of decisions) {
      try {
        prepared.push({
          loreId: d.lore_id,
          content: d.new_content,
          vector: await embedding.embed(d.new_content, signal),
        });
      } catch {}
    }
    return prepared;
  }
  async function commitLoreUpdates(
    prepared: PreparedLoreUpdate[],
    batchId?: string | null,
    repos = repositories,
  ) {
    let applied = 0;
    for (const update of prepared) {
      try {
        await commitLoreOverride(update, batchId, repos);
        applied++;
      } catch {}
    }
    return applied;
  }
  async function commitSecretReveal(
    reveal: PreparedSecretReveal,
    batchId?: string | null,
    repos = repositories,
  ) {
    let factId: string | null = null;
    try {
      if (reveal.vector !== null)
        factId = await repos.facts.insert(
          {
            text: reveal.text,
            fact_type: "event",
            participants: [],
            importance: 4,
            valence: 0,
            turn: 0,
            batch_id: batchId,
          },
          reveal.vector,
        );
    } catch {}
    await repos.lore.reveal(reveal.secretId, batchId, factId);
  }
  async function applySecretReveal(
    secretId: string,
    text: string,
    batchId?: string | null,
  ) {
    let vector: number[] | null = null;
    try {
      vector = await embedding.embed(text, signal);
    } catch {}
    await commitSecretReveal({ secretId, text, vector }, batchId);
  }
  async function prepareSecretReveals(
    drafts: FactDraft[],
  ): Promise<PreparedSecretReveal[]> {
    if (!drafts.length) return [];
    const neighbors: { id: string; text: string }[][] = [];
    for (const draft of drafts) {
      try {
        const vec = await embedding.embed(draft.text, signal),
          hits = await repositories.vectors.searchSecretIds(
            vec,
            deps.loreNeighborK ?? LORE_NEIGHBOR_K,
            maxDist,
          );
        if (!hits.length) {
          neighbors.push([]);
          continue;
        }
        const revealed = await repositories.lore.revealedIds(
            hits.map((h) => h.secret_id),
          ),
          secrets = await repositories.lore.secretsByIds(
            hits
              .filter((h) => !revealed.has(h.secret_id))
              .map((h) => h.secret_id),
          );
        neighbors.push(secrets.map((s) => ({ id: s.id, text: s.text })));
      } catch {
        neighbors.push([]);
      }
    }
    const decisions = await runSecretRevealDetection(
        drafts,
        neighbors,
        model,
        signal,
      ),
      texts = new Map(neighbors.flat().map((n) => [n.id, n.text])),
      prepared: PreparedSecretReveal[] = [];
    for (const d of decisions) {
      const text = texts.get(d.secret_id);
      if (text === undefined) continue;
      let vector: number[] | null = null;
      try {
        vector = await embedding.embed(text, signal);
      } catch {}
      prepared.push({ secretId: d.secret_id, text, vector });
    }
    return prepared;
  }
  async function commitSecretReveals(
    prepared: PreparedSecretReveal[],
    batchId?: string | null,
    repos = repositories,
  ) {
    let revealed = 0;
    for (const reveal of prepared) {
      try {
        await commitSecretReveal(reveal, batchId, repos);
        revealed++;
      } catch {}
    }
    return revealed;
  }
  async function prepareRollbackSessionLore(
    batchIds: string[],
  ): Promise<PreparedLoreRollback> {
    const states: PreparedLoreRollback["states"] = [];
    if (batchIds.length)
      for (const state of await repositories.lore.statesForBatches(batchIds)) {
        let vector: number[] | null = null;
        if (
          state.prior_override_content !== null &&
          state.prior_override_fact_id
        ) {
          try {
            vector = await embedding.embed(
              state.prior_override_content,
              signal,
            );
          } catch {}
        }
        states.push({ state, vector });
      }
    return { batchIds, states };
  }
  async function commitRollbackSessionLore(
    prepared: PreparedLoreRollback,
    repos = repositories,
  ) {
    const stats = {
      overrides_reverted: 0,
      overrides_restored: 0,
      reveals_deleted: 0,
    };
    if (!prepared.batchIds.length) return stats;
    for (const { state, vector } of prepared.states) {
      if (state.prior_override_content === null) {
        if (state.override_fact_id)
          await repos.facts.deleteFact(state.override_fact_id);
        await repos.lore.deleteState(state.lore_id);
        stats.overrides_reverted++;
        continue;
      }
      if (state.prior_override_fact_id && vector !== null) {
        try {
          await repos.facts.updateText(
            state.prior_override_fact_id,
            state.prior_override_content,
            vector,
          );
        } catch {}
      }
      await repos.lore.restorePrior(state.lore_id);
      stats.overrides_restored++;
    }
    stats.reveals_deleted = await repos.lore.deleteRevealsForBatches(
      prepared.batchIds,
    );
    return stats;
  }
  async function rollbackSessionLore(batchIds: string[]) {
    return commitRollbackSessionLore(
      await prepareRollbackSessionLore(batchIds),
    );
  }
  async function ensureSecretsIndexed(entry: SourceLoreEntry) {
    const existing = await repositories.lore.secretsFor(entry.id);
    if (existing.length) return existing;
    let texts: string[];
    try {
      texts = parseSecretExtraction(
        await model.complete(buildSecretExtractionPrompt(entry.content), {
          signal,
        }),
      );
    } catch {
      return [];
    }
    if (!texts.length) return [];
    const secrets = await repositories.lore.setSecrets(entry.id, texts);
    for (const secret of secrets) {
      try {
        const vec = await embedding.embed(secret.text, signal);
        await repositories.vectors.storeSecretVector(secret.id, entry.id, vec);
      } catch {}
    }
    return secrets;
  }
  async function reindexSecrets(entry: SourceLoreEntry) {
    if ((await repositories.lore.secretsFor(entry.id)).length) {
      await repositories.lore.deleteSecrets(entry.id);
      await repositories.vectors.deleteSecretVectorsByLore(entry.id);
    }
    return ensureSecretsIndexed(entry);
  }
  async function indexLoreEntry(entry: SourceLoreEntry) {
    const chunks = chunkLoreContent(entry.content),
      prefix = [entry.category, entry.name].filter(Boolean).join(", ");
    try {
      await repositories.lore.deleteChunks(entry.id);
      await repositories.vectors.deleteLoreVector(entry.id);
      if (chunks.length === 1) {
        await repositories.vectors.storeLoreVector(
          entry.id,
          await embedding.embed(
            prefix ? `${prefix}: ${entry.content}` : entry.content,
            signal,
          ),
          0,
        );
        return chunks;
      }
      for (let i = 0; i < chunks.length; i++) {
        try {
          const chunk = chunks[i]!,
            vec = await embedding.embed(
              prefix ? `${prefix}: ${chunk}` : chunk,
              signal,
            );
          await repositories.vectors.storeLoreVector(entry.id, vec, i);
          await repositories.lore.insertChunk(entry.id, i, chunk);
        } catch {}
      }
    } catch {}
    return chunks;
  }

  return {
    fetchCandidates,
    fetchLoreCandidates: fetchCandidates,
    applySessionLoreOverride,
    commitLoreOverride,
    prepareLoreUpdates,
    commitLoreUpdates,
    prepareSecretReveals,
    commitSecretReveals,
    commitSecretReveal,
    applySecretReveal,
    rollbackSessionLore,
    prepareRollbackSessionLore,
    commitRollbackSessionLore,
    ensureSecretsIndexed,
    reindexSecrets,
    indexLoreEntry,
    detectAndApplyLoreUpdates: async (
      drafts: FactDraft[],
      batchId?: string | null,
    ) => ({
      checked: drafts.length,
      applied: await commitLoreUpdates(
        await prepareLoreUpdates(drafts),
        batchId,
      ),
    }),
    detectAndRevealSecrets: async (
      drafts: FactDraft[],
      batchId?: string | null,
    ) => ({
      checked: drafts.length,
      revealed: await commitSecretReveals(
        await prepareSecretReveals(drafts),
        batchId,
      ),
    }),
  };
}
