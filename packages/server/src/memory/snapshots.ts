import { createHash, randomUUID } from "node:crypto";
import type {
  MemoryDatabase,
  EmbeddingProfile,
  TranscriptMessage,
} from "./types.js";
import { CANONICAL_TABLES, type CanonicalData } from "./profile-reindex.js";
import { quoteSchema } from "./schema.js";
import {
  encryptMemoryText,
  decryptMemoryText,
  type MemoryEncryptionKey,
} from "./crypto.js";
import { logicalTranscript } from "./provenance.js";
import { exchanges } from "./retrieval.js";

export function settledPrefixHash(
  messages: TranscriptMessage[],
  pairs: number,
  group = false,
): string {
  const prefix = exchanges(logicalTranscript(messages), group)
    .slice(0, Math.max(0, pairs))
    .flatMap((pair) =>
      pair.map((row) => [
        row.role,
        row.content,
        row.sourceVersion ?? "",
        row.selectedAnswerId ?? "",
      ]),
    );
  return createHash("sha256").update(JSON.stringify(prefix)).digest("hex");
}
export function factForgetHash(text: string): string {
  return createHash("sha256")
    .update(text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex");
}
export function remapSnapshot(
  input: CanonicalData,
  sessionId: string,
): CanonicalData {
  const data = Object.fromEntries(
    CANONICAL_TABLES.map((t) => [t, (input[t] ?? []).map((r) => ({ ...r }))]),
  ) as CanonicalData;
  const identities = new Map<string, string>();
  const originalSession = String(data.sessions[0]?.id ?? "");
  // Recovery of the same session must preserve the IDs exposed by its inspector.
  if (originalSession === sessionId) return data;
  for (const table of [
    "memory_facts",
    "memory_vectors",
    "memory_extract_batches",
    "memory_clusters",
    "memory_cluster_items",
    "session_secret_reveals",
    "session_lore_state",
  ] as const)
    for (const row of data[table])
      if (typeof row.id === "string")
        identities.set(
          row.id,
          `${sessionId}:${originalSession && row.id.startsWith(originalSession + ":") ? row.id.slice(originalSession.length + 1) : row.id}`,
        );
  for (const table of CANONICAL_TABLES)
    for (const row of data[table]) {
      if (table === "sessions") row.id = sessionId;
      if ("session_id" in row) row.session_id = sessionId;
      for (const column of [
        "id",
        "fact_id",
        "batch_id",
        "superseded_by",
        "cluster_id",
        "override_fact_id",
        "prior_override_fact_id",
      ])
        if (typeof row[column] === "string" && identities.has(row[column]))
          row[column] = identities.get(row[column]);
      if (
        table === "memory_clusters" &&
        typeof row.source_batch_ids === "string"
      )
        row.source_batch_ids = JSON.stringify(
          (JSON.parse(row.source_batch_ids) as string[]).map(
            (id) => identities.get(id) ?? id,
          ),
        );
      if (table === "memory_reinforce_log") delete row.seq;
    }
  return data;
}
export function filterForgottenSnapshot(
  data: CanonicalData,
  hashes: Set<string>,
  key: MemoryEncryptionKey,
): CanonicalData {
  const removed = new Set(
    data.memory_facts
      .filter((f) =>
        hashes.has(factForgetHash(decryptMemoryText(String(f.text), key))),
      )
      .map((f) => f.id),
  );
  data.memory_facts = data.memory_facts.filter((f) => !removed.has(f.id));
  data.memory_cluster_items = data.memory_cluster_items.filter(
    (f) => !removed.has(f.fact_id),
  );
  data.session_lore_state = data.session_lore_state.filter(
    (f) => !removed.has(f.override_fact_id),
  );
  data.session_secret_reveals = data.session_secret_reveals.filter(
    (f) => !removed.has(f.fact_id),
  );
  if (removed.size) {
    data.memory_clusters = [];
    data.memory_cluster_items = [];
    data.cluster_vectors = [];
  }
  return data;
}
export async function captureSessionSnapshot(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
  sessionId: string,
): Promise<CanonicalData> {
  const s = quoteSchema(profile.schemaName);
  const data = Object.fromEntries(
    CANONICAL_TABLES.map((t) => [t, [] as Record<string, unknown>[]]),
  ) as CanonicalData;
  data.sessions = (
    await db.query(`SELECT * FROM ${s}.sessions WHERE id=$1`, [sessionId])
  ).rows;
  for (const table of [
    "memory_facts",
    "memory_extract_cursors",
    "memory_extract_batches",
    "memory_reinforce_log",
    "session_secret_reveals",
    "session_lore_state",
    "memory_clusters",
    "memory_vectors",
    "cluster_vectors",
  ] as const)
    data[table] = (
      await db.query(`SELECT * FROM ${s}.${table} WHERE session_id=$1`, [
        sessionId,
      ])
    ).rows;
  data.memory_cluster_items = (
    await db.query(
      `SELECT i.* FROM ${s}.memory_cluster_items i JOIN ${s}.memory_clusters c ON c.id=i.cluster_id WHERE c.session_id=$1`,
      [sessionId],
    )
  ).rows;
  return data;
}
export async function saveSessionSnapshot(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
  sessionId: string,
  pairs: number,
  messages: TranscriptMessage[],
  key: MemoryEncryptionKey,
  provenance?: { worldHash: string; group: boolean; epoch?: number },
): Promise<void> {
  const data = await captureSessionSnapshot(db, profile, sessionId);
  await db.query(
    `INSERT INTO memory_snapshots(profile_id,session_id,pair_count,source_hash,payload,epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(profile_id,session_id,pair_count) DO UPDATE SET source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,epoch=EXCLUDED.epoch`,
    [
      profile.id,
      sessionId,
      pairs,
      settledPrefixHash(messages, pairs, provenance?.group),
      encryptMemoryText(
        JSON.stringify({
          profileId: profile.id,
          data,
          worldHash: provenance?.worldHash ?? "",
        }),
        key,
      ),
      provenance?.epoch ?? 0,
    ],
  );
}
export async function loadSessionSnapshot(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
  sessionId: string,
  settled: number,
  messages: TranscriptMessage[],
  key: MemoryEncryptionKey,
  provenance?: { worldHash: string; group: boolean; minimumEpoch?: number },
): Promise<{ data: CanonicalData; profileId: string; pairs: number } | null> {
  const rows = (
    await db.query(
      `SELECT pair_count,source_hash FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2 AND pair_count<=$3 AND epoch>=$4 ORDER BY pair_count DESC`,
      [profile.id, sessionId, settled, provenance?.minimumEpoch ?? 0],
    )
  ).rows;
  for (const row of rows)
    if (
      row.source_hash ===
      settledPrefixHash(messages, Number(row.pair_count), provenance?.group)
    ) {
      const stored = (
        await db.query(
          `SELECT payload FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2 AND pair_count=$3`,
          [profile.id, sessionId, row.pair_count],
        )
      ).rows[0];
      const payload = JSON.parse(
        decryptMemoryText(String(stored?.payload), key),
      ) as { data: CanonicalData; profileId: string; worldHash: string };
      if (provenance && payload.worldHash !== provenance.worldHash) continue;
      return { ...payload, pairs: Number(row.pair_count) };
    }
  return null;
}
export const snapshotSessionId = () => `snapshot:${randomUUID()}`;
