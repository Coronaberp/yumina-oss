import {
  createMemoryRepositories,
  type MemoryRepositories,
  type LoreInput,
  type StoredLore,
} from "./repositories/index.js";
import type { EmbeddingClient, MemoryModel } from "./types.js";
import { buildSecretExtractionPrompt, parseSecretExtraction } from "./lore.js";
import { chunkLoreContent } from "./retrieval.js";

export interface AuthoredLoreEntry extends LoreInput {
  id: string;
  enabled?: boolean;
  secrets?: string[];
  links?: Array<{ targetId: string; label: string }>;
}
export interface AuthoredLoreDependencies {
  repositories: MemoryRepositories;
  embedding: EmbeddingClient;
  model: MemoryModel;
  entries: AuthoredLoreEntry[];
  worldId: string;
  signal?: AbortSignal;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Reconciles one complete authored world snapshot; provider work precedes the fenced commit. */
export async function reconcileAuthoredLore(
  deps: AuthoredLoreDependencies,
): Promise<void> {
  const { repositories: repos, worldId, embedding, model, signal } = deps;
  const context = repos.lore.context;
  if (context.scope.charId !== worldId)
    throw new Error("Invalid authored lore world");
  const entries = deps.entries.filter((entry) => entry.enabled !== false);
  const ids = new Set(entries.map((entry) => entry.id));
  if (
    ids.size !== entries.length ||
    entries.some(
      (entry) =>
        !entry.id.startsWith(`${worldId}:`) ||
        (entry.char_id !== undefined && entry.char_id !== worldId),
    )
  ) {
    throw new Error("Invalid authored lore entry");
  }
  const previous = (await repos.lore.listForCharacter()).filter(
    (entry) => entry.char_id === worldId,
  );
  const removed = previous.filter((entry) => !ids.has(entry.id));
  const prepared: Array<{
    entry: AuthoredLoreEntry;
    prior: StoredLore | undefined;
    changed: boolean;
    contentChanged: boolean;
    replaceSecrets: boolean;
    texts: string[];
    secretVectors: Map<number, number[]>;
    indexLore: boolean;
    chunks: string[];
    vectors: Array<{ part: number; text: string; vector: number[] }>;
  }> = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const prior = previous.find((old) => old.id === entry.id);
    const contentChanged = !!prior && prior.content !== entry.content;
    const existingSecrets = prior ? await repos.lore.secretsFor(entry.id) : [];
    let texts: string[];
    if (entry.secrets !== undefined) texts = [...entry.secrets];
    else if (prior?.hidden && !entry.hidden) texts = [];
    else if (
      entry.hidden &&
      (!prior || contentChanged || !existingSecrets.length)
    ) {
      texts = parseSecretExtraction(
        await model.complete(buildSecretExtractionPrompt(entry.content), {
          signal,
        }),
      );
    } else texts = existingSecrets.map((secret) => secret.text);
    const replaceSecrets =
      contentChanged ||
      !same(
        texts,
        existingSecrets.map((secret) => secret.text),
      );
    const vectorRows = prior
      ? (
          await context.run((db) =>
            db.query(
              `SELECT secret_id FROM ${context.table("secret_vectors")} WHERE lore_id=$1`,
              [entry.id],
            ),
          )
        ).rows
      : [];
    const indexed = new Set(vectorRows.map((row) => row.secret_id));
    const secretVectors = new Map<number, number[]>();
    for (const [index, text] of texts.entries()) {
      if (replaceSecrets || !indexed.has(existingSecrets[index]?.id))
        secretVectors.set(index, await embedding.embed(text, signal));
    }
    const indexLore =
      !prior ||
      contentChanged ||
      prior.name !== entry.name ||
      prior.category !== (entry.category ?? "") ||
      !(await repos.vectors.countLoreVectors(entry.id));
    const chunks = indexLore ? chunkLoreContent(entry.content) : [];
    const prefix = [entry.category, entry.name].filter(Boolean).join(", ");
    const vectors: Array<{ part: number; text: string; vector: number[] }> = [];
    for (const [part, text] of chunks.entries())
      vectors.push({
        part,
        text,
        vector: await embedding.embed(
          prefix ? `${prefix}: ${text}` : text,
          signal,
        ),
      });
    const changed =
      !prior ||
      prior.name !== entry.name ||
      prior.content !== entry.content ||
      prior.hidden !== !!entry.hidden ||
      prior.always !== !!entry.always ||
      !same(prior.keys, entry.keys ?? []) ||
      !same(prior.require_keys, entry.require_keys ?? []) ||
      !same(prior.exclude_keys, entry.exclude_keys ?? []) ||
      !same(prior.metadata, entry.metadata ?? {}) ||
      prior.category !== (entry.category ?? "");
    prepared.push({
      entry,
      prior,
      changed,
      contentChanged,
      replaceSecrets,
      texts,
      secretVectors,
      indexLore,
      chunks,
      vectors,
    });
  }
  signal?.throwIfAborted();
  await context.run(async (db) => {
    const bound = createMemoryRepositories(db, context.scope, context.key);
    const t = (name: string) => context.table(name);
    // Secrets and overrides are profile-wide lore, but facts are session-scoped. Resolve
    // only references belonging to this owner/world before deleting their derived facts.
    async function removeReferences(loreId: string, overrides: boolean) {
      const refs = await db.query(
        `SELECT r.fact_id,r.session_id FROM ${t("session_secret_reveals")} r JOIN ${t("lore_secrets")} secret ON secret.id=r.secret_id JOIN ${t("sessions")} s ON s.id=r.session_id WHERE secret.lore_id=$1 AND s.user_id=$2 AND s.char_id=$3`,
        [loreId, context.scope.ownerUserId, worldId],
      );
      if (overrides)
        refs.rows.push(
          ...(
            await db.query(
              `SELECT override_fact_id AS fact_id,session_id FROM ${t("session_lore_state")} r JOIN ${t("sessions")} s ON s.id=r.session_id WHERE lore_id=$1 AND s.user_id=$2 AND s.char_id=$3`,
              [loreId, context.scope.ownerUserId, worldId],
            )
          ).rows,
        );
      const factIds = refs.rows.map((row) => row.fact_id).filter(Boolean);
      const sessions = [...new Set(refs.rows.map((row) => row.session_id))];
      if (factIds.length) {
        await db.query(
          `DELETE FROM ${t("memory_reinforce_log")} WHERE fact_id=ANY($1::text[])`,
          [factIds],
        );
        await db.query(
          `DELETE FROM ${t("memory_facts")} WHERE id=ANY($1::text[]) AND session_id=ANY($2::text[])`,
          [factIds, sessions],
        );
      }
      if (sessions.length) {
        await db.query(
          `DELETE FROM ${t("memory_cluster_items")} WHERE cluster_id IN (SELECT id FROM ${t("memory_clusters")} WHERE session_id=ANY($1::text[]))`,
          [sessions],
        );
        await db.query(
          `DELETE FROM ${t("cluster_vectors")} WHERE session_id=ANY($1::text[])`,
          [sessions],
        );
        await db.query(
          `DELETE FROM ${t("memory_clusters")} WHERE session_id=ANY($1::text[])`,
          [sessions],
        );
      }
      await db.query(
        `DELETE FROM ${t("session_secret_reveals")} WHERE secret_id IN (SELECT id FROM ${t("lore_secrets")} WHERE lore_id=$1)`,
        [loreId],
      );
      if (overrides)
        await db.query(
          `DELETE FROM ${t("session_lore_state")} WHERE lore_id=$1`,
          [loreId],
        );
    }
    for (const entry of removed) {
      await removeReferences(entry.id, true);
      await db.query(
        `DELETE FROM ${t("lore_links")} WHERE lore_id_a=$1 OR lore_id_b=$1`,
        [entry.id],
      );
      await bound.vectors.deleteLoreVector(entry.id);
      await bound.lore.deleteSecrets(entry.id);
      await db.query(
        `DELETE FROM ${t("lore")} WHERE id=$1 AND owner_id=$2 AND char_id=$3`,
        [entry.id, context.scope.ownerUserId, worldId],
      );
    }
    for (const p of prepared) {
      if (p.replaceSecrets && p.prior)
        await removeReferences(p.entry.id, false);
      if (p.changed) await bound.lore.upsert({ ...p.entry, char_id: worldId });
      if (p.indexLore) {
        await bound.lore.deleteChunks(p.entry.id);
        await bound.vectors.deleteLoreVector(p.entry.id);
        for (const part of p.vectors) {
          await bound.vectors.storeLoreVector(
            p.entry.id,
            part.vector,
            part.part,
          );
          if (p.chunks.length > 1)
            await bound.lore.insertChunk(p.entry.id, part.part, part.text);
        }
      }
      const secrets = p.replaceSecrets
        ? await bound.lore.setSecrets(p.entry.id, p.texts)
        : await bound.lore.secretsFor(p.entry.id);
      for (const [index, vector] of p.secretVectors)
        await bound.vectors.storeSecretVector(
          secrets[index]!.id,
          p.entry.id,
          vector,
        );
    }
    // Lore links are undirected in the source schema. Canonicalize pairs so
    // unchanged snapshots keep their identities and do not invalidate a reindex.
    const desired = new Map<string, { a: string; b: string; label: string }>();
    for (const entry of entries)
      for (const link of entry.links ?? []) {
        const target = link.targetId.startsWith(`${worldId}:`)
          ? link.targetId
          : `${worldId}:${link.targetId}`;
        if (!ids.has(target) || target === entry.id) continue;
        const [a, b] = [entry.id, target].sort() as [string, string];
        desired.set(JSON.stringify([a, b]), {
          a,
          b,
          label: Array.from(link.label.trim()).slice(0, 60).join(""),
        });
      }
    const currentLinks = await bound.lore.linksFor(
      entries.map((entry) => entry.id),
    );
    const current = new Map(
      currentLinks.map((link) => {
        const [a, b] = [link.lore_id_a, link.lore_id_b].sort() as [
          string,
          string,
        ];
        return [JSON.stringify([a, b]), { a, b, label: link.label }] as const;
      }),
    );
    const canonical = (
      items: Map<string, { a: string; b: string; label: string }>,
    ) => [...items].sort((a, b) => a[0].localeCompare(b[0]));
    if (!same(canonical(current), canonical(desired))) {
      const oldIds = previous.map((entry) => entry.id);
      await db.query(
        `DELETE FROM ${t("lore_links")} WHERE lore_id_a=ANY($1::text[]) OR lore_id_b=ANY($1::text[])`,
        [oldIds],
      );
      for (const link of desired.values())
        await bound.lore.addLink(link.a, link.b, link.label);
    }
  });
}

/** Retrieval view only. Detection/reconciliation continues using the unfiltered repositories. */
export function visibleLoreRepositories(
  repos: MemoryRepositories,
  eligibleIds?: Set<string>,
): MemoryRepositories {
  const visible = (entry: { id: string; hidden?: boolean } | null) =>
    entry && !entry.hidden && (!eligibleIds || eligibleIds.has(entry.id));
  const loreOverrides = {
    get: async (id: string) => {
      const entry = await repos.lore.get(id);
      return visible(entry) ? entry : null;
    },
    byIds: async (ids: string[]) =>
      (await repos.lore.byIds(ids)).filter(visible),
    listForCharacter: async (global = false) =>
      (await repos.lore.listForCharacter(global)).filter(visible),
    chunksFor: async (id: string) =>
      visible(await repos.lore.get(id)) ? repos.lore.chunksFor(id) : [],
    linksFor: async (ids: string[]) => {
      const links = await repos.lore.linksFor(ids);
      const endpoints = new Set(
        (
          await repos.lore.byIds([
            ...new Set(
              links.flatMap((link) => [link.lore_id_a, link.lore_id_b]),
            ),
          ])
        )
          .filter(visible)
          .map((entry) => entry.id),
      );
      return links.filter(
        (link) =>
          endpoints.has(link.lore_id_a) && endpoints.has(link.lore_id_b),
      );
    },
  };
  const searchLoreChunks: MemoryRepositories["vectors"]["searchLoreChunks"] =
    async (vector, k, maxDist, global = false) => {
      const c = repos.vectors.context;
      return c.run(async (db) => {
        const rows = (
          await db.query(
            `SELECT v.lore_id,v.part_id,v.embedding <=> $3::vector AS distance FROM ${c.table("lore_vectors")} v JOIN ${c.table("lore")} l ON l.id=v.lore_id WHERE l.owner_id=$1 AND l.hidden=0 AND l.usable_as_persona=0 AND (v.char_id=$2 OR ($5 AND v.char_id IS NULL)) AND ($6::text[] IS NULL OR l.id=ANY($6::text[])) ORDER BY distance LIMIT $4`,
            [
              c.scope.ownerUserId,
              c.scope.charId,
              await c.vector(db, vector),
              k,
              global,
              eligibleIds ? [...eligibleIds] : null,
            ],
          )
        ).rows;
        return rows
          .filter((row) => Number(row.distance) <= maxDist)
          .map((row) => ({
            lore_id: String(row.lore_id),
            part_id: Number(row.part_id),
            distance: Number(row.distance),
          }));
      });
    };
  const vectorOverrides = {
    searchLoreChunks,
    searchLoreIds: async (
      vector: readonly number[],
      k: number,
      maxDist: number,
      global = false,
    ) => {
      const hits = await searchLoreChunks(vector, k * 4, maxDist, global);
      const best = new Map<string, number>();
      for (const hit of hits)
        if (!best.has(hit.lore_id) || hit.distance < best.get(hit.lore_id)!)
          best.set(hit.lore_id, hit.distance);
      return [...best]
        .sort((a, b) => a[1] - b[1])
        .slice(0, k)
        .map(([id]) => id);
    },
  };
  function wrap<T extends object>(
    target: T,
    overrides: Record<string, unknown>,
  ): T {
    return new Proxy(target, {
      get(object, key) {
        if (typeof key === "string" && Object.hasOwn(overrides, key))
          return overrides[key];
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }
  return {
    ...repos,
    lore: wrap(repos.lore, loreOverrides),
    vectors: wrap(repos.vectors, vectorOverrides),
  };
}
