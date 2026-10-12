import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./types.js";

export interface MemoryJobInput {
  profileId: string;
  sessionId: string;
  epoch: number;
  sourceHash: string;
  kind: string;
  payload: Record<string, unknown>;
}
export interface MemoryJobClaim extends MemoryJobInput {
  id: string;
  token: string;
  generation: number;
}

/** Short leases fence accepted results. Provider calls always happen outside transactions. */
export class MemoryJobs {
  constructor(
    readonly db: MemoryDatabase,
    private readonly clock: () => number = Date.now,
  ) {}
  async initialize(): Promise<void> {
    for (const ddl of [
      `CREATE TABLE IF NOT EXISTS memory_session_epochs(profile_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch BIGINT NOT NULL,deleted BOOLEAN NOT NULL DEFAULT false,PRIMARY KEY(profile_id,session_id))`,
      `CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch BIGINT NOT NULL,source_hash TEXT NOT NULL,kind TEXT NOT NULL,payload JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending',token TEXT,generation INTEGER NOT NULL DEFAULT 0,lease_until BIGINT,error_code TEXT,UNIQUE(profile_id,session_id,epoch,source_hash,kind))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_jobs_one_worker ON memory_jobs(profile_id,session_id) WHERE status='processing'`,
      `CREATE TABLE IF NOT EXISTS memory_forget_ledger(profile_id TEXT NOT NULL,session_id TEXT NOT NULL,fact_hash TEXT NOT NULL,PRIMARY KEY(profile_id,session_id,fact_hash))`,
      `CREATE TABLE IF NOT EXISTS memory_snapshots(profile_id TEXT NOT NULL,session_id TEXT NOT NULL,pair_count INTEGER NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(profile_id,session_id,pair_count))`,
      `ALTER TABLE memory_snapshots ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0`,
    ])
      await this.db.query(ddl);
  }
  async syncEpoch(
    profileId: string,
    sessionId: string,
    epoch: number,
    deleted = false,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO memory_session_epochs(profile_id,session_id,epoch,deleted) VALUES($1,$2,$3,$4)
        ON CONFLICT(profile_id,session_id) DO UPDATE SET epoch=EXCLUDED.epoch,deleted=EXCLUDED.deleted
        WHERE memory_session_epochs.epoch<=EXCLUDED.epoch AND NOT memory_session_epochs.deleted RETURNING epoch,deleted`,
        [profileId, sessionId, epoch, deleted],
      );
      const current = result.rows[0];
      if (!current) return false;
      await tx.query(
        `UPDATE memory_jobs SET status='cancelled',generation=generation+1,token=NULL,lease_until=NULL
        WHERE profile_id=$1 AND session_id=$2 AND status IN ('pending','processing') AND (epoch<$3 OR $4)`,
        [profileId, sessionId, epoch, deleted],
      );
      return current.deleted === false;
    });
  }
  async isCurrent(
    profileId: string,
    sessionId: string,
    epoch: number,
  ): Promise<boolean> {
    return (
      (
        await this.db.query(
          `SELECT 1 FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2 AND epoch=$3 AND NOT deleted`,
          [profileId, sessionId, epoch],
        )
      ).rows.length === 1
    );
  }
  async enqueue(input: MemoryJobInput): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO memory_jobs(id,profile_id,session_id,epoch,source_hash,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT(profile_id,session_id,epoch,source_hash,kind) DO UPDATE SET id=memory_jobs.id RETURNING id`,
      [
        randomUUID(),
        input.profileId,
        input.sessionId,
        input.epoch,
        input.sourceHash,
        input.kind,
        JSON.stringify(input.payload),
      ],
    );
    return String(r.rows[0]!.id);
  }
  async claim(leaseMs = 120_000): Promise<MemoryJobClaim | null> {
    const token = randomUUID();
    const now = this.clock();
    return this.db.transaction(async (tx) => {
      const owner = (
        await tx.query(
          `SELECT e.profile_id,e.session_id FROM memory_session_epochs e WHERE NOT e.deleted
        AND EXISTS(SELECT 1 FROM memory_jobs j WHERE j.profile_id=e.profile_id AND j.session_id=e.session_id AND j.epoch=e.epoch AND (j.status='pending' OR (j.status='processing' AND j.lease_until<$1)))
        AND NOT EXISTS(SELECT 1 FROM memory_jobs busy WHERE busy.profile_id=e.profile_id AND busy.session_id=e.session_id AND busy.status='processing' AND busy.lease_until>=$1)
        ORDER BY e.profile_id,e.session_id FOR UPDATE OF e SKIP LOCKED LIMIT 1`,
          [now],
        )
      ).rows[0];
      if (!owner) return null;
      // A separate statement after the session lock sees the preceding claimant's commit.
      if (
        (
          await tx.query(
            `SELECT 1 FROM memory_jobs WHERE profile_id=$1 AND session_id=$2 AND status='processing' AND lease_until>=$3`,
            [owner.profile_id, owner.session_id, now],
          )
        ).rows.length
      )
        return null;
      await tx.query(
        `UPDATE memory_jobs SET status='pending',token=NULL,lease_until=NULL WHERE profile_id=$1 AND session_id=$2 AND status='processing' AND lease_until<$3`,
        [owner.profile_id, owner.session_id, now],
      );
      const r = await tx.query(
        `UPDATE memory_jobs SET status='processing',token=$1,generation=generation+1,lease_until=$2
        WHERE id=(SELECT j.id FROM memory_jobs j JOIN memory_session_epochs e ON e.profile_id=j.profile_id AND e.session_id=j.session_id
        WHERE j.epoch=e.epoch AND NOT e.deleted AND j.status='pending' AND j.profile_id=$3 AND j.session_id=$4
        ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`,
        [token, now + leaseMs, owner.profile_id, owner.session_id],
      );
      const row = r.rows[0];
      return row
        ? {
            id: String(row.id),
            profileId: String(row.profile_id),
            sessionId: String(row.session_id),
            epoch: Number(row.epoch),
            sourceHash: String(row.source_hash),
            kind: String(row.kind),
            payload: row.payload as Record<string, unknown>,
            token,
            generation: Number(row.generation),
          }
        : null;
    });
  }
  private async transition(
    claim: MemoryJobClaim,
    status: string,
    error: string | null,
    lease: number | null,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query(
        `SELECT 1 FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2 AND epoch=$3 AND NOT deleted FOR UPDATE`,
        [claim.profileId, claim.sessionId, claim.epoch],
      );
      if (!current.rows.length) return false;
      const result = await tx.query(
        `UPDATE memory_jobs SET status=$1,error_code=$2,lease_until=$3 WHERE id=$4 AND token=$5 AND generation=$6 AND status='processing' AND lease_until>=$7 AND profile_id=$8 AND session_id=$9 AND epoch=$10 RETURNING id`,
        [
          status,
          error,
          lease,
          claim.id,
          claim.token,
          claim.generation,
          this.clock(),
          claim.profileId,
          claim.sessionId,
          claim.epoch,
        ],
      );
      return result.rows.length === 1;
    });
  }
  heartbeat(claim: MemoryJobClaim, leaseMs = 120_000): Promise<boolean> {
    return this.transition(claim, "processing", null, this.clock() + leaseMs);
  }
  finish(claim: MemoryJobClaim): Promise<boolean> {
    return this.transition(claim, "ready", null, null);
  }
  fail(claim: MemoryJobClaim, error: string): Promise<boolean> {
    return this.transition(claim, "failed", error, null);
  }
  async assertClaim(tx: MemoryDatabase, claim: MemoryJobClaim): Promise<void> {
    // Match claim(), syncEpoch() and transition(): lock the session before its job.
    const current = await tx.query(
      `SELECT 1 FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2 AND epoch=$3 AND NOT deleted FOR UPDATE`,
      [claim.profileId, claim.sessionId, claim.epoch],
    );
    if (!current.rows.length) throw new Error("memory_stale_claim");
    const result = await tx.query(
      `SELECT 1 FROM memory_jobs WHERE id=$1 AND token=$2 AND generation=$3 AND status='processing' AND lease_until>=$4 AND profile_id=$5 AND session_id=$6 AND epoch=$7 FOR UPDATE`,
      [
        claim.id,
        claim.token,
        claim.generation,
        this.clock(),
        claim.profileId,
        claim.sessionId,
        claim.epoch,
      ],
    );
    if (!result.rows.length) throw new Error("memory_stale_claim");
  }
  async retry(profileId: string, sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE memory_jobs SET status='pending',token=NULL,lease_until=NULL WHERE profile_id=$1 AND session_id=$2 AND status='failed'`,
      [profileId, sessionId],
    );
  }
  async cancel(profileId: string, sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE memory_jobs SET status='cancelled',generation=generation+1,token=NULL,lease_until=NULL WHERE profile_id=$1 AND session_id=$2 AND status IN ('pending','processing')`,
      [profileId, sessionId],
    );
  }
}
