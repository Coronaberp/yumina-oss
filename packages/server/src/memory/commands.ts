import { sql } from "drizzle-orm";
import type { StoryhavenFact, StoryhavenMemoryStatus } from "@yumina/shared";
import { resolveMemoryRecallBudget } from "@yumina/shared";
import { db } from "../db/index.js";
import type { StoryhavenMemoryController } from "../routes/storyhaven-memory.js";
import { getMemoryRuntime } from "./runtime.js";
import { createMemoryRepositories } from "./repositories/index.js";
import { createEmbeddingClient } from "./embeddings.js";
import { createLoreService } from "./lore.js";
import { ensureIdentity, quoteSchema } from "./schema.js";
import { publicEmbeddingProfile } from "./profile-input.js";
import { decryptMemoryText } from "./crypto.js";
import { materializePendingMemoryFork } from "./fork.js";
import {
  factForgetHash,
  filterForgottenSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
} from "./snapshots.js";
import {
  loadStoryhavenTurnContext,
  ensureStoryhavenSnapshotCurrent,
  retrieveStoryhavenMemory,
  scheduleStoryhavenMemory,
  scopeFor,
  purgeDerived,
  restoreDerived,
  settledPairs,
  wakeMemoryWorker,
} from "./yumina-adapter.js";
import type { AdapterContext } from "./yumina-adapter.js";
import type { EmbeddingProfile, MemoryDatabase, MemoryFact } from "./types.js";

/** Explicit fields prevent database rows, vectors and credentials reaching the client. */
export function publicFact(f: MemoryFact): StoryhavenFact {
  return {
    id: f.id,
    text: f.text,
    fact_type: f.fact_type,
    participants: f.participants,
    importance: f.importance,
    valence: f.valence,
    reinforcements: f.reinforcements,
    valid_from_turn: f.valid_from_turn,
    valid_until_turn: f.valid_until_turn,
    last_turn: f.last_turn,
    pinned: f.pinned,
    location: f.location,
    superseded_by: f.superseded_by,
    expired_ts: f.expired_ts,
  };
}
export async function markMemoryAccountEnabled(owner: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO storyhaven_memory_accounts(user_id) SELECT id FROM "user" WHERE id=${owner} ON CONFLICT DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch) SELECT s.user_id,s.id,'profile-activated',m.epoch FROM play_sessions s JOIN storyhaven_memory_sessions m ON m.session_id=s.id WHERE s.user_id=${owner} AND m.backend='storyhaven'`,
  );
  wakeMemoryWorker();
}
async function context(owner: string, sid: string) {
  return loadStoryhavenTurnContext({
    ownerUserId: owner,
    actingUserId: owner,
    sessionId: sid,
  });
}
async function checkpoint(ctx: AdapterContext, p: EmbeddingProfile) {
  await materializePendingMemoryFork(ctx.ownerUserId, ctx.sessionId);
  const r = await getMemoryRuntime();
  const snapshot = await loadSessionSnapshot(
    r.database,
    p,
    ctx.sessionId,
    settledPairs(ctx),
    ctx.messages,
    r.key,
    {
      worldHash: ctx.worldHash,
      group: ctx.mode === "group",
      minimumEpoch: ctx.resetEpoch,
    },
  );
  if (!snapshot || snapshot.pairs < ctx.frontier) return null;
  const hashes = new Set(
    (
      await r.database.query<{ fact_hash: string }>(
        "SELECT fact_hash FROM memory_forget_ledger WHERE profile_id=$1 AND session_id=$2",
        [p.id, ctx.sessionId],
      )
    ).rows.map((row) => row.fact_hash),
  );
  return {
    ...snapshot,
    data: filterForgottenSnapshot(snapshot.data, hashes, r.key),
  };
}
async function status(
  owner: string,
  sid: string,
): Promise<StoryhavenMemoryStatus> {
  const ctx = await context(owner, sid),
    r = await getMemoryRuntime(),
    p = await r.profiles.getActive(owner);
  const row = (
    await db.execute(
      sql`SELECT status,error_code FROM storyhaven_memory_sessions WHERE session_id=${sid}`,
    )
  ).rows[0];
  const base: StoryhavenMemoryStatus = {
    backend: ctx.backend ?? "legacy",
    profile: p
      ? publicEmbeddingProfile(
          p,
          !!(await r.profiles.getCredential(owner, p.id)),
        )
      : null,
    epoch: ctx.epoch,
    frontier: ctx.frontier,
    status: p ? String(row?.status ?? "idle") : "unconfigured",
    errorCode: (row?.error_code as string | null) ?? null,
    settings: { ...ctx.settings, memoryBudgetTokens: resolveMemoryRecallBudget(ctx.settings.memoryBudgetTokens, ctx.defaultMemoryBudgetTokens) } as StoryhavenMemoryStatus["settings"],
    memoryBudgetTokensInherited: ctx.settings.memoryBudgetTokens == null,
    facts: [],
    clusters: [],
    lore: [],
    overrides: [],
    reveals: [],
  };
  if (!p) return base;
  await ensureIdentity(r.database, scopeFor(p, ctx));
  const repos = createMemoryRepositories(r.database, scopeFor(p, ctx), r.key),
    snapshot = await checkpoint(ctx, p);
  if (snapshot) {
    base.facts = snapshot.data.memory_facts.map((f) =>
      publicFact(repos.facts.decode(f)),
    );
    base.clusters = snapshot.data.memory_clusters.map((c) => ({
      id: c.id,
      title: decryptMemoryText(String(c.title ?? ""), r.key),
      summary_text: decryptMemoryText(String(c.summary_text), r.key),
      created_turn: c.created_turn,
      source_batch_ids: JSON.parse(String(c.source_batch_ids)),
      created_at: c.created_at,
    }));
    base.overrides = snapshot.data.session_lore_state
      .filter((o) => o.override_content !== null)
      .map((o) => ({
        lore_id: o.lore_id,
        override_content: decryptMemoryText(String(o.override_content), r.key),
        override_fact_id: o.override_fact_id,
      }));
    const secrets = await repos.lore.secretsByIds(
      snapshot.data.session_secret_reveals.map((s) => String(s.secret_id)),
    );
    base.reveals = snapshot.data.session_secret_reveals.map((s) => ({
      secret_id: s.secret_id,
      text: secrets.find((secret) => secret.id === s.secret_id)?.text,
    }));
  }
  const revealed = new Set(base.reveals.map((s) => s.secret_id));
  for (const lore of await repos.lore.listForCharacter(false)) {
    const authored = ctx.loreEntries.find((entry) => entry.id === lore.id);
    if (
      !authored ||
      authored.content !== lore.content ||
      !!authored.hidden !== lore.hidden
    )
      continue;
    const secrets = await repos.lore.secretsFor(lore.id);
    base.lore.push({
      id: lore.id,
      name: lore.hidden ? "Hidden lore" : lore.name,
      hidden: lore.hidden,
      ...(!lore.hidden
        ? { content: lore.content, metadata: lore.metadata }
        : {}),
      secrets: secrets.map((s) => ({
        id: s.id,
        revealed: revealed.has(s.id),
        ...(revealed.has(s.id) ? { text: s.text } : {}),
      })),
    });
  }
  if (!(await ensureStoryhavenSnapshotCurrent(ctx)))
    throw new Error("memory_history_changed");
  return base;
}

/** Persist the invalidation before any external work; the outbox can repair interrupted mutations. */
async function invalidate(
  ctx: AdapterContext,
  kind: string,
  settings?: Record<string, unknown>,
  backend?: string,
  frontier?: number,
): Promise<AdapterContext> {
  await db.transaction(async (tx) => {
    const row = (
      await tx.execute(
        sql`SELECT m.epoch FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE s.id=${ctx.sessionId} AND s.user_id=${ctx.ownerUserId} FOR UPDATE OF m,s`,
      )
    ).rows[0];
    if (Number(row?.epoch) !== ctx.epoch)
      throw new Error("memory_history_changed");
    const result = (
      await tx.execute(
        sql`UPDATE storyhaven_memory_sessions SET epoch=epoch+1,reset_epoch=CASE WHEN ${kind} IN ('clear','rebuild') THEN epoch+1 ELSE reset_epoch END,settings=${JSON.stringify(settings ?? ctx.settings)}::jsonb,backend=${backend ?? ctx.backend ?? "legacy"},frontier=${frontier ?? ctx.frontier},status='pending',error_code=NULL,updated_at=NOW() WHERE session_id=${ctx.sessionId} RETURNING epoch`,
      )
    ).rows[0];
    await tx.execute(
      sql`INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload) VALUES(${ctx.ownerUserId},${ctx.sessionId},${kind},${Number(result!.epoch)},'{}')`,
    );
  });
  return {
    ...ctx,
    epoch: ctx.epoch + 1,
    settings: settings ?? ctx.settings,
    backend: (backend ?? ctx.backend ?? "legacy") as AdapterContext["backend"],
    frontier: frontier ?? ctx.frontier,
    resetEpoch:
      kind === "clear" || kind === "rebuild" ? ctx.epoch + 1 : ctx.resetEpoch,
  };
}
async function mutateFacts(
  ctx: AdapterContext,
  p: EmbeddingProfile,
  write: (tx: MemoryDatabase) => Promise<void>,
  pairs: number,
  credential?: string | null,
): Promise<void> {
  const r = await getMemoryRuntime();
  if (!(await ensureStoryhavenSnapshotCurrent(ctx)))
    throw new Error("memory_history_changed");
  await db.transaction(async (appTx) => {
    const row = (
      await appTx.execute(
        sql`SELECT m.epoch FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE s.id=${ctx.sessionId} AND s.user_id=${ctx.ownerUserId} FOR UPDATE OF m,s`,
      )
    ).rows[0];
    // Every selected-answer/history/world mutation increments this row atomically;
    // holding its lock fences that provenance check through the memory commit.
    if (Number(row?.epoch) !== ctx.epoch)
      throw new Error("memory_history_changed");
    await r.database.transaction(async (tx) => {
      const current = (
        await tx.query(
          "SELECT id,credential FROM memory_registry.profiles WHERE user_id=$1 AND active FOR SHARE",
          [ctx.ownerUserId],
        )
      ).rows[0];
      if (
        current?.id !== p.id ||
        (credential !== undefined && current.credential !== credential)
      )
        throw new Error("memory_profile_changed");
      await write(tx);
      await saveSessionSnapshot(
        tx,
        p,
        ctx.sessionId,
        pairs,
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
export async function createStoryhavenController(
  owner: string,
  sid: string,
): Promise<StoryhavenMemoryController | null> {
  if (
    !(
      await db.execute(
        sql`SELECT id FROM play_sessions WHERE id=${sid} AND user_id=${owner}`,
      )
    ).rows.length
  )
    return null;
  return {
    status: () => status(owner, sid),
    async mutate(action, payload) {
      let ctx = await context(owner, sid);
      const r = await getMemoryRuntime(),
        p = await r.profiles.getActive(owner);
      if (action === "preview")
        return (
          await retrieveStoryhavenMemory({
            ownerUserId: owner,
            actingUserId: owner,
            sessionId: sid,
            query: String(payload.query),
          })
        ).result;
      if (action === "settings") {
        const settings = {
          ...ctx.settings,
          ...(payload.settings as Record<string, unknown>),
        };
        if (settings.model === null) delete settings.model;
        if (settings.memoryBudgetTokens === null) delete settings.memoryBudgetTokens;
        ctx = await invalidate(
          ctx,
          "settings",
          settings,
          payload.backend as string | undefined,
        );
        if (ctx.backend === "storyhaven")
          await scheduleStoryhavenMemory(sid, owner);
        return status(owner, sid);
      }
      if (!p) throw new Error("memory_profile_unavailable");
      const scope = scopeFor(p, ctx);
      await ensureIdentity(r.database, scope);
      let repos = createMemoryRepositories(r.database, scope, r.key);
      if (action === "lineage") {
        const snapshot = await checkpoint(ctx, p);
        const facts =
          snapshot?.data.memory_facts.map((row) => repos.facts.decode(row)) ??
          [];
        const id = String(payload.id);
        if (!facts.some((fact) => fact.id === id)) return [];
        const seen = new Set([id]),
          chain: MemoryFact[] = [];
        let frontier = [id];
        for (let depth = 0; frontier.length && depth < 20; depth++) {
          const next: string[] = [];
          for (const current of frontier)
            for (const fact of facts) {
              if (fact.superseded_by !== current || seen.has(fact.id)) continue;
              seen.add(fact.id);
              chain.push(fact);
              next.push(fact.id);
            }
          frontier = next;
        }
        return chain
          .sort((a, b) => a.valid_from_turn - b.valid_from_turn)
          .map(publicFact);
      }
      if (action === "retry") {
        await r.jobs.retry(p.id, sid);
        await scheduleStoryhavenMemory(sid, owner);
        wakeMemoryWorker();
        return status(owner, sid);
      }
      if (action === "clear" || action === "rebuild") {
        const frontier = action === "clear" ? settledPairs(ctx) : 0;
        ctx = await invalidate(ctx, action, undefined, undefined, frontier);
        await r.jobs.syncEpoch(p.id, sid, ctx.epoch);
        await mutateFacts(
          ctx,
          p,
          async (tx) => {
            await purgeDerived(tx, p, sid);
            await ensureIdentity(tx, scope);
            await tx.query(
              "DELETE FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
              [p.id, sid],
            );
            await createMemoryRepositories(tx, scope, r.key).facts.setCursor(
              frontier,
            );
          },
          frontier,
        );
        if (action === "rebuild") await scheduleStoryhavenMemory(sid, owner);
        wakeMemoryWorker();
        return status(owner, sid);
      }
      const snap = await checkpoint(ctx, p);
      const capturedCredential = (
        await r.database.query<{ credential: string | null }>(
          "SELECT credential FROM memory_registry.profiles WHERE id=$1 AND user_id=$2",
          [p.id, owner],
        )
      ).rows[0]?.credential;
      const id = String(payload.id ?? "");
      let vector: number[] | undefined;
      const embedding = createEmbeddingClient(
        p,
        await r.profiles.getCredential(owner, p.id),
      );
      if (action === "fact" && typeof payload.text === "string")
        vector = await embedding.embed(payload.text);
      if (action === "override" && typeof payload.content === "string")
        vector = await embedding.embed(payload.content);
      let secret: { id: string; text: string } | undefined;
      if (action === "reveal" && payload.revealed) {
        secret = (await repos.lore.secretsByIds([String(payload.secretId)]))[0];
        if (!secret) throw new Error("memory_secret_unavailable");
        vector = await embedding.embed(secret.text);
      }
      if (!(await ensureStoryhavenSnapshotCurrent(ctx)))
        throw new Error("memory_history_changed");
      ctx = await invalidate(ctx, "manual");
      await r.jobs.syncEpoch(p.id, sid, ctx.epoch);
      await mutateFacts(
        ctx,
        p,
        async (tx) => {
          if (snap) await restoreDerived(tx, p, scope, snap.data);
          else {
            await purgeDerived(tx, p, sid);
            await ensureIdentity(tx, scope);
            await createMemoryRepositories(tx, scope, r.key).facts.setCursor(
              ctx.frontier,
            );
          }
          repos = createMemoryRepositories(tx, scope, r.key);
          const s = quoteSchema(p.schemaName);
          if (action === "fact" || action === "forget") {
            const fact = await repos.facts.get(id);
            if (!fact) throw new Error("memory_fact_unavailable");
            if (action === "forget") {
              const hash = factForgetHash(fact.text);
              await tx.query(
                "INSERT INTO memory_forget_ledger(profile_id,session_id,fact_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                [p.id, sid, hash],
              );
              const matching = (await repos.facts.listAll()).filter(
                (f) => factForgetHash(f.text) === hash,
              );
              for (const f of matching) {
                await tx.query(
                  `DELETE FROM ${s}.session_lore_state WHERE session_id=$1 AND override_fact_id=$2`,
                  [sid, f.id],
                );
                await tx.query(
                  `DELETE FROM ${s}.session_secret_reveals WHERE session_id=$1 AND fact_id=$2`,
                  [sid, f.id],
                );
                await repos.facts.deleteFact(f.id);
              }
              await repos.clusters.purgeSession();
            } else {
              if (typeof payload.text === "string")
                await repos.facts.updateText(id, payload.text, vector!);
              if (typeof payload.pinned === "boolean")
                await repos.facts.setPinned(id, payload.pinned);
              if (payload.expired === true) await repos.facts.expire(id);
              if (payload.expired === false)
                await tx.query(
                  `UPDATE ${s}.memory_facts SET expired_ts=NULL WHERE id=$1 AND session_id=$2`,
                  [id, sid],
                );
              // Existing summaries must not continue quoting an edited fact.
              if (typeof payload.text === "string" || payload.expired === true)
                await repos.clusters.purgeSession();
            }
          } else if (action === "override") {
            const loreId = String(payload.loreId);
            if (!(await repos.lore.get(loreId)))
              throw new Error("memory_lore_unavailable");
            if (payload.content === null) {
              const prior = await repos.lore.getState(loreId);
              await repos.lore.deleteState(loreId);
              if (prior?.override_fact_id)
                await repos.facts.deleteFact(prior.override_fact_id);
            } else
              await createLoreService({
                repositories: repos,
                embedding,
                model: {
                  complete: async () => {
                    throw new Error("Manual override never invokes a model");
                  },
                },
                charId: ctx.worldId,
              }).commitLoreOverride({
                loreId,
                content: String(payload.content),
                vector: vector!,
              });
          } else if (action === "reveal") {
            if (payload.revealed)
              await createLoreService({
                repositories: repos,
                embedding,
                model: {
                  complete: async () => {
                    throw new Error("Manual reveal never invokes a model");
                  },
                },
                charId: ctx.worldId,
              }).commitSecretReveal({
                secretId: secret!.id,
                text: secret!.text,
                vector: vector!,
              });
            else {
              const existing = (
                await tx.query(
                  `DELETE FROM ${s}.session_secret_reveals WHERE session_id=$1 AND secret_id=$2 RETURNING fact_id`,
                  [sid, String(payload.secretId)],
                )
              ).rows;
              for (const row of existing)
                if (row.fact_id)
                  await repos.facts.deleteFact(String(row.fact_id));
              await repos.clusters.purgeSession();
            }
          } else throw new Error("memory_action_unavailable");
        },
        snap?.pairs ?? ctx.frontier,
        capturedCredential,
      );
      wakeMemoryWorker();
      return status(owner, sid);
    },
  };
}
