import type { MemoryDatabase } from "../types.js";
import { RepositoryContext, nid, now } from "./context.js";
import { FactsRepository } from "./facts.js";
export interface StoredMemoryCluster {
  id: string;
  session_id: string;
  title: string;
  summary_text: string;
  created_turn: number;
  source_batch_ids: string[];
  created_at: number;
  [key: string]: unknown;
}
export class ClustersRepository {
  constructor(
    readonly context: RepositoryContext,
    private facts: FactsRepository,
  ) {}
  private t(name = "memory_clusters") {
    return this.context.table(name);
  }
  private decode(r: Record<string, unknown>): StoredMemoryCluster {
    return {
      ...r,
      title: r.title ? this.context.decrypt(r.title) : "",
      summary_text: this.context.decrypt(r.summary_text),
      source_batch_ids: JSON.parse(String(r.source_batch_ids)),
      created_at: Number(r.created_at),
    } as StoredMemoryCluster;
  }
  private async vectorOn(
    db: MemoryDatabase,
    id: string,
    vec: readonly number[],
  ) {
    await db.query(
      `INSERT INTO ${this.t("cluster_vectors")}(cluster_id,session_id,embedding) VALUES($1,$2,$3::vector) ON CONFLICT(cluster_id) DO UPDATE SET embedding=EXCLUDED.embedding WHERE ${this.t("cluster_vectors")}.session_id=EXCLUDED.session_id`,
      [id, this.context.scope.sessionId, await this.context.vector(db, vec)],
    );
  }
  async insert(
    summary: string,
    turn: number,
    batches: string[],
    title = "",
    vec?: readonly number[],
  ) {
    return this.context.run(async (db) => {
      for (const batch of batches)
        await this.context.requireBatchScope(db, batch);
      const id = nid("memclust");
      await db.query(
        `INSERT INTO ${this.t()}(id,session_id,title,summary_text,created_turn,source_batch_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          this.context.scope.sessionId,
          title ? this.context.encrypt(title) : "",
          this.context.encrypt(summary),
          turn,
          JSON.stringify(batches),
          Date.now() / 1000,
        ],
      );
      if (vec) await this.vectorOn(db, id, vec);
      return id;
    });
  }
  async updateCluster(
    id: string,
    summary: string,
    turn: number,
    extraBatches: string[],
    vec?: readonly number[],
  ) {
    return this.context.run(async (db) => {
      for (const batch of extraBatches)
        await this.context.requireBatchScope(db, batch);
      const r = await db.query(
        `SELECT source_batch_ids FROM ${this.t()} WHERE id=$1 AND session_id=$2 FOR UPDATE`,
        [id, this.context.scope.sessionId],
      );
      if (!r.rows.length) throw new Error("Memory entity not found");
      const batches = [
        ...new Set([
          ...JSON.parse(String(r.rows[0]!.source_batch_ids)),
          ...extraBatches,
        ]),
      ].sort();
      await db.query(
        `UPDATE ${this.t()} SET summary_text=$3,created_turn=$4,source_batch_ids=$5 WHERE id=$1 AND session_id=$2`,
        [
          id,
          this.context.scope.sessionId,
          this.context.encrypt(summary),
          turn,
          JSON.stringify(batches),
        ],
      );
      if (vec) await this.vectorOn(db, id, vec);
    });
  }
  async addMembers(id: string, facts: string[]) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_clusters", id);
      for (const fid of facts) {
        await this.context.requireEntity(db, "memory_facts", fid);
        await db.query(
          `INSERT INTO ${this.t("memory_cluster_items")}(id,cluster_id,fact_id,created_ts) VALUES($1,$2,$3,$4) ON CONFLICT(cluster_id,fact_id) DO NOTHING`,
          [nid("mci"), id, fid, now()],
        );
      }
    });
  }
  async members(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_clusters", id);
      return (
        await db.query(
          `SELECT fact_id FROM ${this.t("memory_cluster_items")} WHERE cluster_id=$1`,
          [id],
        )
      ).rows.map((r) => String(r.fact_id));
    });
  }
  async unclusteredFacts() {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t("memory_facts")} f WHERE f.session_id=$1 AND f.expired_ts IS NULL AND f.valid_until_turn IS NULL AND f.id NOT IN (SELECT fact_id FROM ${this.t("memory_cluster_items")})`,
          [this.context.scope.sessionId],
        )
      ).rows.map((r) => this.facts.decode(r)),
    );
  }
  async activeForSession() {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE session_id=$1 ORDER BY created_turn DESC`,
          [this.context.scope.sessionId],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async latestForSession() {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT * FROM ${this.t()} WHERE session_id=$1 ORDER BY created_turn DESC LIMIT 1`,
        [this.context.scope.sessionId],
      );
      return r.rows[0] ? this.decode(r.rows[0]) : null;
    });
  }
  async deleteOverlapping(batches: string[]) {
    if (!batches.length) return 0;
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT id,source_batch_ids FROM ${this.t()} WHERE session_id=$1`,
        [this.context.scope.sessionId],
      );
      const wanted = new Set(batches);
      const ids = r.rows
        .filter((r) =>
          (JSON.parse(String(r.source_batch_ids)) as string[]).some((b) =>
            wanted.has(b),
          ),
        )
        .map((r) => String(r.id));
      await this.deleteOn(db, ids);
      return ids.length;
    });
  }
  private async deleteOn(db: MemoryDatabase, ids: string[]) {
    await db.query(
      `DELETE FROM ${this.t("memory_cluster_items")} WHERE cluster_id=ANY($1::text[])`,
      [ids],
    );
    await db.query(
      `DELETE FROM ${this.t("cluster_vectors")} WHERE cluster_id=ANY($1::text[]) AND session_id=$2`,
      [ids, this.context.scope.sessionId],
    );
    await db.query(
      `DELETE FROM ${this.t()} WHERE id=ANY($1::text[]) AND session_id=$2`,
      [ids, this.context.scope.sessionId],
    );
  }
  async purgeSession() {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT id FROM ${this.t()} WHERE session_id=$1`,
        [this.context.scope.sessionId],
      );
      await this.deleteOn(
        db,
        r.rows.map((r) => String(r.id)),
      );
    });
  }
}
