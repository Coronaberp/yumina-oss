import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getMemoryRuntime } from "./runtime.js";
import { CANONICAL_TABLES, type CanonicalData } from "./profile-reindex.js";
import {
  loadSessionSnapshot,
  remapSnapshot,
  filterForgottenSnapshot,
  settledPrefixHash,
} from "./snapshots.js";
import { encryptMemoryText } from "./crypto.js";
import { exchanges } from "./retrieval.js";
import type { TranscriptMessage } from "./types.js";

export interface MemoryForkInput {
  ownerUserId: string;
  parentSessionId: string;
  childSessionId: string;
  parentMessages: TranscriptMessage[];
  childMessages: TranscriptMessage[];
  worldHash: string;
  group: boolean;
}
interface FrozenFork {
  profileId: string;
  pairs: number;
  sourceHash: string;
  encryptedPayload: string;
  forgetHashes: string[];
  epoch: number;
}
/** Freeze the selected prefix in the app transaction; never consult the parent again. */
export async function captureStoryhavenMemoryFork(
  appTx: Pick<typeof db, "execute">,
  input: MemoryForkInput,
): Promise<{
  backend: "legacy" | "storyhaven" | null;
  eventId: number | null;
}> {
  const present = (
    await appTx.execute(
      sql`SELECT to_regclass('public.storyhaven_memory_sessions') AS name`,
    )
  ).rows[0]?.name;
  if (!present) return { backend: null, eventId: null };
  const metadata = (
    await appTx.execute(
      sql`SELECT m.* FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE m.session_id=${input.parentSessionId} AND s.user_id=${input.ownerUserId} FOR UPDATE OF m`,
    )
  ).rows[0];
  if (!metadata) return { backend: null, eventId: null };
  const backend = metadata.backend as "legacy" | "storyhaven" | null;
  const settings = (metadata.settings ?? {}) as Record<string, unknown>;
  const settled = Math.max(
    0,
    exchanges(input.parentMessages, input.group).length -
      Number(settings.settleMarginExchanges ?? 1),
  );
  const frontier = Math.min(Number(metadata.frontier ?? 0), settled);
  const inherited = await appTx.execute(
    sql`UPDATE storyhaven_memory_sessions m SET backend=${backend},settings=${JSON.stringify(settings)}::jsonb,frontier=${frontier},epoch=0,reset_epoch=0,status='idle',error_code=NULL,source_hash=NULL FROM play_sessions child,play_sessions parent WHERE m.session_id=child.id AND child.id=${input.childSessionId} AND child.user_id=${input.ownerUserId} AND parent.id=${input.parentSessionId} AND parent.user_id=${input.ownerUserId} AND child.world_id=parent.world_id RETURNING m.session_id`,
  );
  if (!inherited.rows.length) throw new Error("memory_fork_scope");
  if (backend !== "storyhaven") return { backend, eventId: null };
  const runtime = await getMemoryRuntime();
  // Forks copy owned storage even when the shared provider is unavailable.
  const profile = await runtime.profiles.getOwnActive(input.ownerUserId);
  const frozen = await runtime.database.transaction(async (memoryTx) => {
    await memoryTx.query(
      "SELECT user_id FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE",
      [input.ownerUserId],
    );
    if (
      profile &&
      !(
        await memoryTx.query(
          "SELECT 1 FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 AND active",
          [profile?.id ?? "", input.ownerUserId],
        )
      ).rows.length
    )
      throw new Error("memory_fork_profile_changed");
    const checkpoint = profile
      ? await loadSessionSnapshot(
          memoryTx,
          profile,
          input.parentSessionId,
          settled,
          input.parentMessages,
          runtime.key,
          {
            worldHash: input.worldHash,
            group: input.group,
            minimumEpoch: Number(metadata.reset_epoch ?? 0),
          },
        )
      : null;
    if (
      !profile &&
      (
        await memoryTx.query(
          "SELECT 1 FROM memory_registry.profiles WHERE user_id=$1 AND active",
          [input.ownerUserId],
        )
      ).rows.length
    )
      throw new Error("memory_fork_profile_changed");
    const hashes = (
      await memoryTx.query<{ fact_hash: string }>(
        "SELECT DISTINCT l.fact_hash FROM memory_forget_ledger l JOIN memory_registry.profiles p ON p.id=l.profile_id WHERE p.user_id=$1 AND l.session_id=$2",
        [input.ownerUserId, input.parentSessionId],
      )
    ).rows.map((row) => row.fact_hash);
    const valid =
      checkpoint && checkpoint.pairs >= frontier ? checkpoint : null;
    const empty = Object.fromEntries(
      CANONICAL_TABLES.map((t) => [t, [] as Record<string, unknown>[]]),
    ) as CanonicalData;
    const data = remapSnapshot(
      filterForgottenSnapshot(
        valid?.data ?? empty,
        new Set(hashes),
        runtime.key,
      ),
      input.childSessionId,
    );
    const pairs = valid?.pairs ?? frontier;
    return {
      profileId: valid?.profileId ?? profile?.id ?? "",
      pairs,
      sourceHash: settledPrefixHash(input.childMessages, pairs, input.group),
      encryptedPayload: encryptMemoryText(
        JSON.stringify({
          profileId: valid?.profileId ?? profile?.id ?? "",
          data,
          worldHash: input.worldHash,
        }),
        runtime.key,
      ),
      forgetHashes: hashes,
      epoch: 0,
    } satisfies FrozenFork;
  });
  const event = (
    await appTx.execute(
      sql`INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload) VALUES(${input.ownerUserId},${input.childSessionId},'fork',0,${JSON.stringify(frozen)}::jsonb) RETURNING id`,
    )
  ).rows[0];
  return { backend, eventId: Number(event!.id) };
}

/** Idempotent delivery after app commit, also called by recall/worker recovery. */
export async function materializePendingMemoryFork(
  ownerUserId: string,
  sessionId: string,
): Promise<void> {
  const pending = (
    await db.execute(
      sql`SELECT id FROM storyhaven_memory_outbox WHERE owner_user_id=${ownerUserId} AND session_id=${sessionId} AND kind='fork' AND delivered_at IS NULL ORDER BY id`,
    )
  ).rows;
  if (!pending.length) return;
  const runtime = await getMemoryRuntime();
  for (const pendingEvent of pending)
    await db.transaction(async (appTx) => {
      const event = (
        await appTx.execute(
          sql`SELECT * FROM storyhaven_memory_outbox WHERE id=${Number(pendingEvent.id)} AND owner_user_id=${ownerUserId} AND session_id=${sessionId} AND kind='fork' AND delivered_at IS NULL FOR UPDATE`,
        )
      ).rows[0];
      if (!event) return;
      const child = (
        await appTx.execute(
          sql`SELECT m.reset_epoch FROM storyhaven_memory_sessions m JOIN play_sessions s ON s.id=m.session_id WHERE s.id=${sessionId} AND s.user_id=${ownerUserId} FOR UPDATE OF m,s`,
        )
      ).rows[0];
      const frozen = event.payload as unknown as FrozenFork;
      if (child) {
        const profile = await runtime.profiles.getOwnActive(ownerUserId);
        if (!profile) return; // Activation later retries the frozen payload.
        await runtime.database.transaction(async (memoryTx) => {
          await memoryTx.query(
            "SELECT user_id FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE",
            [ownerUserId],
          );
          if (
            !(
              await memoryTx.query(
                "SELECT 1 FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 AND active",
                [profile.id, ownerUserId],
              )
            ).rows.length
          )
            throw new Error("memory_fork_profile_changed");
          if (Number(child.reset_epoch) <= frozen.epoch)
            await memoryTx.query(
              "INSERT INTO memory_snapshots(profile_id,session_id,pair_count,source_hash,payload,epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(profile_id,session_id,pair_count) DO NOTHING",
              [
                profile.id,
                sessionId,
                frozen.pairs,
                frozen.sourceHash,
                frozen.encryptedPayload,
                frozen.epoch,
              ],
            );
          for (const hash of frozen.forgetHashes)
            await memoryTx.query(
              "INSERT INTO memory_forget_ledger(profile_id,session_id,fact_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
              [profile.id, sessionId, hash],
            );
        });
      }
      await appTx.execute(
        sql`UPDATE storyhaven_memory_outbox SET delivered_at=NOW() WHERE id=${Number(event.id)}`,
      );
    });
}
