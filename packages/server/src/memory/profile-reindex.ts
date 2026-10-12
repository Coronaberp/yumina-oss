import { createHash, randomUUID } from "node:crypto";
import type {
  EmbeddingClient,
  EmbeddingProfile,
  MemoryDatabase,
} from "./types.js";
import { quoteSchema } from "./schema.js";
import { decryptMemoryText, type MemoryEncryptionKey } from "./crypto.js";
import { validateEmbeddingVector } from "./embeddings.js";
import { ProfileRepository } from "./profiles.js";

export const CANONICAL_TABLES = [
  "users",
  "characters",
  "sessions",
  "lore",
  "lore_links",
  "lore_secrets",
  "lore_chunks",
  "memory_facts",
  "memory_extract_cursors",
  "memory_extract_batches",
  "memory_reinforce_log",
  "session_secret_reveals",
  "session_lore_state",
  "memory_clusters",
  "memory_cluster_items",
  "memory_vectors",
  "lore_vectors",
  "secret_vectors",
  "cluster_vectors",
] as const;
type CanonicalTable = (typeof CANONICAL_TABLES)[number];
export type CanonicalData = Record<CanonicalTable, Record<string, unknown>[]>;
function identifier(value: string): string {
  if (!/^[a-z_]+$/.test(value)) throw new Error("memory_invalid_column");
  return `"${value}"`;
}
export async function captureCanonical(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
): Promise<CanonicalData> {
  const schema = quoteSchema(profile.schemaName);
  const data = {} as CanonicalData;
  for (const table of CANONICAL_TABLES) {
    const condition =
      table === "sessions"
        ? " WHERE id NOT LIKE 'snapshot:%'"
        : table === "memory_cluster_items"
          ? ` WHERE cluster_id IN (SELECT id FROM ${schema}.memory_clusters WHERE session_id NOT LIKE 'snapshot:%')`
          : [
                "memory_facts",
                "memory_extract_cursors",
                "memory_extract_batches",
                "memory_reinforce_log",
                "session_secret_reveals",
                "session_lore_state",
                "memory_clusters",
                "memory_vectors",
                "cluster_vectors",
              ].includes(table)
            ? " WHERE session_id NOT LIKE 'snapshot:%'"
            : "";
    const rows = (
      await db.query(`SELECT * FROM ${schema}.${table}${condition}`)
    ).rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([k]) => k !== "embedding" && k !== "pair_key",
        ),
      ),
    );
    data[table] = rows.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return data;
}
export function canonicalHash(data: CanonicalData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
export async function insertCanonical(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
  data: CanonicalData,
): Promise<void> {
  const schema = quoteSchema(profile.schemaName);
  for (const table of CANONICAL_TABLES)
    for (const row of data[table]) {
      const fields = Object.keys(row);
      await db.query(
        `INSERT INTO ${schema}.${table}(${fields.map(identifier).join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")})`,
        fields.map((k) => row[k]),
      );
    }
  if (data.memory_reinforce_log.some((row) => "seq" in row))
    await db.query(
      `SELECT setval(pg_get_serial_sequence($1,'seq'),COALESCE((SELECT MAX(seq) FROM ${schema}.memory_reinforce_log),1),EXISTS(SELECT 1 FROM ${schema}.memory_reinforce_log))`,
      [`${schema}.memory_reinforce_log`],
    );
}
export const PROFILE_REINDEX_DDL = `CREATE TABLE IF NOT EXISTS memory_registry.profile_reindex_attempts(
  profile_id TEXT PRIMARY KEY REFERENCES memory_registry.profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, token TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
  lease_until BIGINT NOT NULL, source_profile_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL, target_revision INTEGER NOT NULL,
  source_credential_hash TEXT NOT NULL, target_credential_hash TEXT NOT NULL)`;
function credentialHash(value: unknown): string {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}
function matchesProfile(
  row: Record<string, unknown> | undefined,
  profile: EmbeddingProfile,
): boolean {
  return (
    !!row &&
    row.id === profile.id &&
    row.user_id === profile.userId &&
    row.schema_name === profile.schemaName &&
    row.base_url === profile.baseUrl &&
    row.model === profile.model &&
    Number(row.dimensions) === profile.dimensions &&
    row.send_dimensions === profile.sendDimensions &&
    Number(row.revision) === profile.revision
  );
}
export interface ProfileReindexClaim {
  userId: string;
  source: EmbeddingProfile;
  target: EmbeddingProfile;
  token: string;
  generation: number;
  sourceCredentialHash: string;
  targetCredentialHash: string;
}
export class ProfileReindexAttempts {
  constructor(
    readonly db: MemoryDatabase,
    private clock: () => number = Date.now,
  ) {}
  async initialize(): Promise<void> {
    await this.db.query(PROFILE_REINDEX_DDL);
  }
  private async lockProfiles(
    tx: MemoryDatabase,
    userId: string,
    ids: string[],
  ) {
    await tx.query(
      "SELECT user_id FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    return (
      await tx.query(
        "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
        [userId, ids],
      )
    ).rows;
  }
  async begin(
    userId: string,
    source: EmbeddingProfile,
    target: EmbeddingProfile,
    leaseMs = 120_000,
  ): Promise<ProfileReindexClaim> {
    if (
      source.userId !== userId ||
      target.userId !== userId ||
      source.id === target.id
    )
      throw new Error("memory_profile_scope");
    quoteSchema(source.schemaName);
    quoteSchema(target.schemaName);
    await this.initialize();
    return this.db.transaction(async (tx) => {
      const rows = await this.lockProfiles(tx, userId, [source.id, target.id]);
      const from = rows.find((r) => r.id === source.id),
        to = rows.find((r) => r.id === target.id);
      if (
        !matchesProfile(from, source) ||
        !matchesProfile(to, target) ||
        !from!.active ||
        to!.active
      )
        throw new Error("memory_profile_changed");
      const prior = (
        await tx.query(
          "SELECT * FROM memory_registry.profile_reindex_attempts WHERE profile_id=$1 FOR UPDATE",
          [target.id],
        )
      ).rows[0];
      const now = this.clock();
      if (prior?.status === "processing" && Number(prior.lease_until) >= now)
        throw new Error("memory_reindex_in_progress");
      const token = randomUUID(),
        generation = Number(prior?.generation ?? 0) + 1;
      const claim = {
        userId,
        source: { ...source },
        target: { ...target },
        token,
        generation,
        sourceCredentialHash: credentialHash(from!.credential),
        targetCredentialHash: credentialHash(to!.credential),
      };
      await tx.query(
        `INSERT INTO memory_registry.profile_reindex_attempts(profile_id,user_id,token,generation,status,lease_until,source_profile_id,source_revision,target_revision,source_credential_hash,target_credential_hash)
        VALUES($1,$2,$3,$4,'processing',$5,$6,$7,$8,$9,$10)
        ON CONFLICT(profile_id) DO UPDATE SET user_id=EXCLUDED.user_id,token=EXCLUDED.token,generation=EXCLUDED.generation,status=EXCLUDED.status,lease_until=EXCLUDED.lease_until,source_profile_id=EXCLUDED.source_profile_id,source_revision=EXCLUDED.source_revision,target_revision=EXCLUDED.target_revision,source_credential_hash=EXCLUDED.source_credential_hash,target_credential_hash=EXCLUDED.target_credential_hash`,
        [
          target.id,
          userId,
          token,
          generation,
          now + leaseMs,
          source.id,
          source.revision,
          target.revision,
          claim.sourceCredentialHash,
          claim.targetCredentialHash,
        ],
      );
      await tx.query(
        `UPDATE memory_registry.profiles SET status='pending',error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND NOT active`,
        [target.id, userId],
      );
      return claim;
    });
  }
  async assert(tx: MemoryDatabase, claim: ProfileReindexClaim): Promise<void> {
    const rows = await this.lockProfiles(tx, claim.userId, [
      claim.source.id,
      claim.target.id,
    ]);
    const source = rows.find((r) => r.id === claim.source.id),
      target = rows.find((r) => r.id === claim.target.id);
    if (
      !matchesProfile(source, claim.source) ||
      !matchesProfile(target, claim.target) ||
      !source!.active ||
      target!.active
    )
      throw new Error("memory_profile_changed");
    if (
      credentialHash(source!.credential) !== claim.sourceCredentialHash ||
      credentialHash(target!.credential) !== claim.targetCredentialHash
    )
      throw new Error("memory_credential_changed");
    const r = await tx.query(
      `SELECT 1 FROM memory_registry.profile_reindex_attempts WHERE profile_id=$1 AND user_id=$2 AND token=$3 AND generation=$4 AND status='processing' AND lease_until>=$5 FOR UPDATE`,
      [
        claim.target.id,
        claim.userId,
        claim.token,
        claim.generation,
        this.clock(),
      ],
    );
    if (!r.rows.length) throw new Error("memory_reindex_stale");
  }
  async heartbeat(
    claim: ProfileReindexClaim,
    leaseMs = 120_000,
  ): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.assert(tx, claim);
        await tx.query(
          `UPDATE memory_registry.profile_reindex_attempts SET lease_until=$5 WHERE profile_id=$1 AND user_id=$2 AND token=$3 AND generation=$4`,
          [
            claim.target.id,
            claim.userId,
            claim.token,
            claim.generation,
            this.clock() + leaseMs,
          ],
        );
        return true;
      });
    } catch {
      return false;
    }
  }
  async fail(claim: ProfileReindexClaim): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const profiles = await this.lockProfiles(tx, claim.userId, [
        claim.target.id,
      ]);
      if (!profiles.length || profiles[0]!.active) return false;
      const result = await tx.query(
        `UPDATE memory_registry.profile_reindex_attempts SET status='failed' WHERE profile_id=$1 AND user_id=$2 AND token=$3 AND generation=$4 AND status='processing' AND lease_until>=$5 RETURNING profile_id`,
        [
          claim.target.id,
          claim.userId,
          claim.token,
          claim.generation,
          this.clock(),
        ],
      );
      if (!result.rows.length) return false;
      await tx.query(
        `UPDATE memory_registry.profiles SET status='failed',error_code='reindex_failed',updated_at=now() WHERE id=$1 AND user_id=$2 AND NOT active`,
        [claim.target.id, claim.userId],
      );
      return true;
    });
  }
  async finish(tx: MemoryDatabase, claim: ProfileReindexClaim): Promise<void> {
    const r = await tx.query(
      `UPDATE memory_registry.profile_reindex_attempts SET status='ready' WHERE profile_id=$1 AND user_id=$2 AND token=$3 AND generation=$4 AND status='processing' AND lease_until>=$5 RETURNING profile_id`,
      [
        claim.target.id,
        claim.userId,
        claim.token,
        claim.generation,
        this.clock(),
      ],
    );
    if (!r.rows.length) throw new Error("memory_reindex_stale");
  }
}
export async function captureReindexCredentials(
  db: MemoryDatabase,
  ownerUserId: string,
  source: EmbeddingProfile,
  target: EmbeddingProfile,
): Promise<{ source: string; target: string }> {
  const rows = (
    await db.query(
      "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND id=ANY($2::text[])",
      [ownerUserId, [source.id, target.id]],
    )
  ).rows;
  const from = rows.find((r) => r.id === source.id),
    to = rows.find((r) => r.id === target.id);
  if (!matchesProfile(from, source) || !matchesProfile(to, target))
    throw new Error("memory_profile_changed");
  return {
    source: credentialHash(from!.credential),
    target: credentialHash(to!.credential),
  };
}
export interface ProfileTestSnapshot {
  revision: number;
  credentialHash: string;
  generation: number;
}
export async function captureProfileTest(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
): Promise<ProfileTestSnapshot> {
  await db.query(PROFILE_REINDEX_DDL);
  return db.transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND id=$2 FOR SHARE",
        [profile.userId, profile.id],
      )
    ).rows[0];
    if (!matchesProfile(row, profile))
      throw new Error("memory_profile_changed");
    const attempt = (
      await tx.query(
        "SELECT generation FROM memory_registry.profile_reindex_attempts WHERE profile_id=$1",
        [profile.id],
      )
    ).rows[0];
    return {
      revision: profile.revision,
      credentialHash: credentialHash(row!.credential),
      generation: Number(attempt?.generation ?? 0),
    };
  });
}
export async function completeProfileTest(
  db: MemoryDatabase,
  profile: EmbeddingProfile,
  captured: ProfileTestSnapshot,
  success: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT user_id FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE",
      [profile.userId],
    );
    const row = (
      await tx.query(
        "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [profile.userId, profile.id],
      )
    ).rows[0];
    if (
      !matchesProfile(row, profile) ||
      row!.active ||
      Number(row!.revision) !== captured.revision ||
      credentialHash(row!.credential) !== captured.credentialHash
    )
      return false;
    const attempt = (
      await tx.query(
        "SELECT generation,status FROM memory_registry.profile_reindex_attempts WHERE profile_id=$1 FOR UPDATE",
        [profile.id],
      )
    ).rows[0];
    if (
      Number(attempt?.generation ?? 0) !== captured.generation ||
      attempt?.status === "processing"
    )
      return false;
    await tx.query(
      "UPDATE memory_registry.profiles SET status=$3,error_code=$4,updated_at=now() WHERE user_id=$1 AND id=$2 AND NOT active",
      [
        profile.userId,
        profile.id,
        success ? "ready" : "failed",
        success ? null : "embedding_unavailable",
      ],
    );
    return true;
  });
}

export interface ReindexOptions {
  db: MemoryDatabase;
  profiles: ProfileRepository;
  ownerUserId: string;
  source: EmbeddingProfile;
  target: EmbeddingProfile;
  key: MemoryEncryptionKey;
  embedding: EmbeddingClient;
  ensureCurrent?: (database?: MemoryDatabase) => Promise<boolean>;
  clock?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  expectedCredentialHashes?: { source: string; target: string };
}
export async function reindexProfile(options: ReindexOptions): Promise<void> {
  const { db, profiles, source, target, key, embedding, ownerUserId } = options;
  if (
    source.userId !== ownerUserId ||
    target.userId !== ownerUserId ||
    source.id === target.id
  )
    throw new Error("memory_profile_scope");
  if (options.ensureCurrent && !(await options.ensureCurrent()))
    throw new Error("memory_source_changed");
  const attempts = new ProfileReindexAttempts(db, options.clock);
  const claim = await attempts.begin(
    ownerUserId,
    source,
    target,
    options.leaseMs,
  );
  if (
    options.expectedCredentialHashes &&
    (claim.sourceCredentialHash !== options.expectedCredentialHashes.source ||
      claim.targetCredentialHash !== options.expectedCredentialHashes.target)
  ) {
    await attempts.fail(claim);
    throw new Error("memory_credential_changed");
  }
  let lost = false;
  const timer = setInterval(() => {
    void attempts
      .heartbeat(claim, options.leaseMs)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, options.heartbeatMs ?? 30_000);
  timer.unref();
  const check = async () => {
    if (lost) throw new Error("memory_reindex_stale");
    await db.transaction((tx) => attempts.assert(tx, claim));
  };
  try {
    const data = await db.transaction((tx) => captureCanonical(tx, source));
    const hash = canonicalHash(data);
    const vectors: Array<{
      table: CanonicalTable;
      keys: Record<string, unknown>;
      vector: number[];
    }> = [];
    const plain = (value: unknown) =>
      decryptMemoryText(String(value ?? ""), key);
    const embed = async (text: string) => {
      await check();
      const result = validateEmbeddingVector(
        await embedding.embed(text),
        target.dimensions,
      );
      await check();
      return result;
    };
    for (const row of data.memory_facts)
      vectors.push({
        table: "memory_facts",
        keys: { id: row.id },
        vector: await embed(plain(row.text)),
      });
    for (const row of data.memory_vectors)
      vectors.push({
        table: "memory_vectors",
        keys: { id: row.id },
        vector: await embed(plain(row.text)),
      });
    for (const row of data.lore_vectors) {
      const lore = data.lore.find((l) => l.id === row.lore_id);
      if (!lore) throw new Error("memory_lore_missing");
      const chunk = data.lore_chunks.find(
        (c) => c.lore_id === row.lore_id && c.part_id === row.part_id,
      );
      const prefix = [plain(lore.category), plain(lore.name)]
        .filter(Boolean)
        .join(", ");
      const content = plain(chunk?.content ?? lore.content);
      vectors.push({
        table: "lore_vectors",
        keys: { lore_id: row.lore_id, part_id: row.part_id },
        vector: await embed(prefix ? `${prefix}: ${content}` : content),
      });
    }
    for (const row of data.secret_vectors) {
      const secret = data.lore_secrets.find((s) => s.id === row.secret_id);
      if (!secret) throw new Error("memory_secret_missing");
      vectors.push({
        table: "secret_vectors",
        keys: { secret_id: row.secret_id },
        vector: await embed(plain(secret.text)),
      });
    }
    for (const row of data.cluster_vectors) {
      const cluster = data.memory_clusters.find((c) => c.id === row.cluster_id);
      if (!cluster) throw new Error("memory_cluster_missing");
      vectors.push({
        table: "cluster_vectors",
        keys: { cluster_id: row.cluster_id },
        vector: await embed(plain(cluster.summary_text)),
      });
    }
    await db.transaction(async (tx) => {
      // Worker acceptance locks epochs before profiles; preserve that order for migration.
      if (
        (
          await tx.query(
            "SELECT to_regclass('memory_session_epochs') AS present",
          )
        ).rows[0]?.present
      )
        await tx.query(
          "SELECT profile_id,session_id FROM memory_session_epochs WHERE profile_id=ANY($1::text[]) ORDER BY profile_id,session_id FOR UPDATE",
          [[source.id, target.id]],
        );
      await attempts.assert(tx, claim);
      const pointer = (
        await tx.query(
          "SELECT id FROM memory_registry.profiles WHERE user_id=$1 AND active FOR UPDATE",
          [ownerUserId],
        )
      ).rows[0];
      if (pointer?.id !== source.id) throw new Error("memory_profile_changed");
      for (const table of CANONICAL_TABLES)
        await tx.query(
          `LOCK TABLE ${quoteSchema(source.schemaName)}.${table} IN SHARE MODE`,
        );
      if (
        canonicalHash(await captureCanonical(tx, source)) !== hash ||
        (options.ensureCurrent && !(await options.ensureCurrent(tx)))
      )
        throw new Error("memory_source_changed");
      for (const table of [...CANONICAL_TABLES].reverse())
        await tx.query(
          `DELETE FROM ${quoteSchema(target.schemaName)}.${table}`,
        );
      await insertCanonical(tx, target, data);
      for (const item of vectors) {
        const keys = Object.keys(item.keys);
        await tx.query(
          `UPDATE ${quoteSchema(target.schemaName)}.${item.table} SET embedding=$1::vector WHERE ${keys.map((k, i) => `${identifier(k)}=$${i + 2}`).join(" AND ")}`,
          [JSON.stringify(item.vector), ...keys.map((k) => item.keys[k])],
        );
      }
      for (const table of [
        "memory_session_epochs",
        "memory_forget_ledger",
        "memory_snapshots",
      ]) {
        if (
          !(await tx.query("SELECT to_regclass($1) AS present", [table]))
            .rows[0]?.present
        )
          continue;
        const columns = (
          await tx.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
            [table],
          )
        ).rows.map((r) => r.column_name);
        await tx.query(`DELETE FROM ${table} WHERE profile_id=$1`, [target.id]);
        await tx.query(
          `INSERT INTO ${table}(${columns.map(identifier).join(",")}) SELECT ${columns.map((c) => (c === "profile_id" ? "$1" : identifier(c))).join(",")} FROM ${table} WHERE profile_id=$2`,
          [target.id, source.id],
        );
      }
      await attempts.assert(tx, claim);
      if (options.ensureCurrent && !(await options.ensureCurrent(tx)))
        throw new Error("memory_source_changed");
      const scopedProfiles = new ProfileRepository(tx, {
        encrypt: (s) => s,
        decrypt: (s) => s,
      });
      await scopedProfiles.setStatus(ownerUserId, target.id, "ready");
      await scopedProfiles.activate(ownerUserId, target.id, target.revision);
      await attempts.finish(tx, claim);
    });
  } catch (error) {
    await attempts.fail(claim);
    throw error;
  } finally {
    clearInterval(timer);
  }
}
