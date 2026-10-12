import type { FactDraft, MemoryDatabase, MemoryFact } from "../types.js";
import { RepositoryContext, nid, now } from "./context.js";
export interface InsertFact extends FactDraft {
  turn: number;
  location?: string | null;
  batch_id?: string | null;
  id?: string;
  session_id?: string;
  char_id?: string | null;
}
export interface MemoryBatch {
  id: string;
  session_id: string;
  pair_start: number;
  pair_end: number;
  turn: number;
  created_ts: number;
}
export interface RollbackResult {
  batches_rolled_back: number;
  facts_deleted: number;
  rewound_cursor: number | null;
  batch_ids: string[];
  reinforcements_restored?: number;
}
export class FactsRepository {
  constructor(readonly context: RepositoryContext) {}
  private t(name = "memory_facts") {
    return this.context.table(name);
  }
  decode(row: Record<string, unknown>): MemoryFact {
    const { embedding, ...r } = row;
    return {
      ...r,
      text: this.context.decrypt(r.text),
      location: this.context.decrypt(r.location) || null,
      created_ts: Number(r.created_ts),
      expired_ts: r.expired_ts === null ? null : Number(r.expired_ts),
    } as unknown as MemoryFact;
  }
  private async insertOn(
    db: MemoryDatabase,
    fact: InsertFact,
    vec: readonly number[],
    pinned = false,
  ): Promise<string> {
    const c = this.context;
    if (fact.session_id && fact.session_id !== c.scope.sessionId)
      throw new Error("Invalid fact session");
    if (fact.char_id !== undefined && fact.char_id !== c.scope.charId)
      throw new Error("Invalid fact character");
    await c.requireBatchScope(db, fact.batch_id);
    const id = fact.id ?? nid("mf");
    await db.query(
      `INSERT INTO ${this.t()}(id,session_id,char_id,text,fact_type,participants,importance,valence,reinforcements,valid_from_turn,valid_until_turn,last_turn,created_ts,expired_ts,superseded_by,pinned,location,batch_id,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,NULL,$9,$10,NULL,NULL,$11,$12,$13,$14::vector)`,
      [
        id,
        c.scope.sessionId,
        c.scope.charId,
        c.encrypt(fact.text),
        fact.fact_type,
        fact.participants ?? [],
        fact.importance || 3,
        fact.valence || 0,
        Math.trunc(fact.turn),
        now(),
        pinned,
        fact.location ? c.encrypt(fact.location) : null,
        fact.batch_id ?? null,
        await c.vector(db, vec),
      ],
    );
    return id;
  }
  async insert(fact: InsertFact, vec: readonly number[], pinned = false) {
    return this.context.run((db) => this.insertOn(db, fact, vec, pinned));
  }
  async get(id: string) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT * FROM ${this.t()} WHERE id=$1 AND session_id=$2`,
        [id, this.context.scope.sessionId],
      );
      return r.rows[0] ? this.decode(r.rows[0]) : null;
    });
  }
  async reinforce(id: string, turn: number, batchId?: string | null) {
    return this.context.run(async (db) => {
      const sid = this.context.scope.sessionId;
      await this.context.requireBatchScope(db, batchId);
      const r = await db.query(
        `SELECT reinforcements,last_turn FROM ${this.t()} WHERE id=$1 AND session_id=$2 FOR UPDATE`,
        [id, sid],
      );
      if (!r.rows.length) throw new Error("Memory entity not found");
      if (batchId)
        await db.query(
          `INSERT INTO ${this.t("memory_reinforce_log")}(session_id,fact_id,batch_id,prior_reinforcements,prior_last_turn,created_ts) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            sid,
            id,
            batchId,
            r.rows[0]!.reinforcements,
            r.rows[0]!.last_turn,
            now(),
          ],
        );
      await db.query(
        `UPDATE ${this.t()} SET reinforcements=reinforcements+1,last_turn=$3 WHERE id=$1 AND session_id=$2`,
        [id, sid, Math.trunc(turn)],
      );
    });
  }
  async updateText(id: string, text: string, vec: readonly number[]) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_facts", id);
      await db.query(
        `UPDATE ${this.t()} SET text=$3,embedding=$4::vector WHERE id=$1 AND session_id=$2`,
        [
          id,
          this.context.scope.sessionId,
          this.context.encrypt(text),
          await this.context.vector(db, vec),
        ],
      );
    });
  }
  async setPinned(id: string, pinned: boolean) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_facts", id);
      await db.query(
        `UPDATE ${this.t()} SET pinned=$3 WHERE id=$1 AND session_id=$2`,
        [id, this.context.scope.sessionId, pinned],
      );
    });
  }
  async expire(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_facts", id);
      await db.query(
        `UPDATE ${this.t()} SET expired_ts=$3 WHERE id=$1 AND session_id=$2`,
        [id, this.context.scope.sessionId, now()],
      );
    });
  }
  async deleteFact(id: string) {
    return this.deleteFacts([id]);
  }
  async deleteFacts(ids: string[]) {
    if (!ids.length) return 0;
    return this.context.run(async (db) => {
      const r = await db.query(
        `DELETE FROM ${this.t()} WHERE id=ANY($1::text[]) AND session_id=$2 RETURNING id`,
        [ids, this.context.scope.sessionId],
      );
      return r.rows.length;
    });
  }
  async supersede(
    oldId: string,
    fact: InsertFact,
    vec: readonly number[],
    turn: number,
  ) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_facts", oldId);
      const id = await this.insertOn(db, fact, vec);
      await db.query(
        `UPDATE ${this.t()} SET valid_until_turn=$3,superseded_by=$4 WHERE id=$1 AND session_id=$2`,
        [oldId, this.context.scope.sessionId, Math.trunc(turn), id],
      );
      return id;
    });
  }
  private async similar(vec: readonly number[], k: number, current: boolean) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT *,embedding <=> $2::vector AS distance FROM ${this.t()} WHERE session_id=$1 AND expired_ts IS NULL ${current ? "AND valid_until_turn IS NULL" : ""} ORDER BY distance LIMIT $3`,
        [this.context.scope.sessionId, await this.context.vector(db, vec), k],
      );
      return r.rows.map((r) => ({
        ...this.decode(r),
        distance: Number(r.distance),
      }));
    });
  }
  async similarLive(vec: readonly number[], k: number) {
    return this.similar(vec, k, false);
  }
  async similarCurrent(vec: readonly number[], k: number) {
    return this.similar(vec, k, true);
  }
  async reserved() {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE session_id=$1 AND expired_ts IS NULL AND (pinned OR (fact_type='state' AND valid_until_turn IS NULL))`,
          [this.context.scope.sessionId],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async listLive(k = 50) {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE session_id=$1 AND expired_ts IS NULL ORDER BY last_turn DESC LIMIT $2`,
          [this.context.scope.sessionId, k],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async listAll() {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE session_id=$1 ORDER BY valid_from_turn,id`,
          [this.context.scope.sessionId],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async countLive() {
    return this.context.run(async (db) =>
      Number(
        (
          await db.query(
            `SELECT count(*) AS count FROM ${this.t()} WHERE session_id=$1 AND expired_ts IS NULL`,
            [this.context.scope.sessionId],
          )
        ).rows[0]!.count,
      ),
    );
  }
  async lineage(ids: string[]) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT id,text,superseded_by,valid_until_turn,valid_from_turn FROM ${this.t()} WHERE session_id=$1 AND superseded_by IS NOT NULL`,
        [this.context.scope.sessionId],
      );
      const predecessors = new Map<string, Record<string, unknown>[]>();
      for (const row of r.rows) {
        const key = String(row.superseded_by);
        predecessors.set(key, [...(predecessors.get(key) ?? []), row]);
      }
      const out: Record<
        string,
        { id: string; text: string; replaced_at_turn: number }[]
      > = {};
      for (const id of ids) {
        const seen = new Set([id]),
          chain: Record<string, unknown>[] = [];
        let frontier = [id];
        for (let depth = 0; frontier.length && depth < 20; depth++) {
          const next: string[] = [];
          for (const current of frontier)
            for (const a of predecessors.get(current) ?? []) {
              if (seen.has(String(a.id))) continue;
              seen.add(String(a.id));
              chain.push(a);
              next.push(String(a.id));
            }
          frontier = next;
        }
        chain.sort(
          (a, b) => Number(a.valid_from_turn) - Number(b.valid_from_turn),
        );
        if (chain.length)
          out[id] = chain.map((a) => ({
            id: String(a.id),
            text: this.context.decrypt(a.text),
            replaced_at_turn: Number(a.valid_until_turn),
          }));
      }
      return out;
    });
  }
  async getCursor() {
    return this.context.run(async (db) =>
      Number(
        (
          await db.query(
            `SELECT settled_exchanges FROM ${this.t("memory_extract_cursors")} WHERE session_id=$1`,
            [this.context.scope.sessionId],
          )
        ).rows[0]?.settled_exchanges ?? 0,
      ),
    );
  }
  async setCursor(pairs: number) {
    return this.context.run((db) => this.cursorOn(db, pairs));
  }
  private async cursorOn(db: MemoryDatabase, pairs: number) {
    await db.query(
      `INSERT INTO ${this.t("memory_extract_cursors")}(session_id,settled_exchanges) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET settled_exchanges=EXCLUDED.settled_exchanges`,
      [this.context.scope.sessionId, Math.trunc(pairs)],
    );
  }
  async recordBatch(id: string, start: number, end: number, turn: number) {
    return this.context.run(async (db) => {
      await db.query(
        `INSERT INTO ${this.t("memory_extract_batches")}(id,session_id,pair_start,pair_end,turn,created_ts) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          id,
          this.context.scope.sessionId,
          Math.trunc(start),
          Math.trunc(end),
          Math.trunc(turn),
          now(),
        ],
      );
    });
  }
  async batches() {
    return this.context.run(
      async (db) =>
        (
          await db.query(
            `SELECT * FROM ${this.t("memory_extract_batches")} WHERE session_id=$1 ORDER BY turn`,
            [this.context.scope.sessionId],
          )
        ).rows as unknown as MemoryBatch[],
    );
  }
  async rollbackFromPairIndex(index: number): Promise<RollbackResult> {
    return this.context.run(async (db) => {
      const sid = this.context.scope.sessionId;
      const batches = await db.query(
        `SELECT * FROM ${this.t("memory_extract_batches")} WHERE session_id=$1 AND pair_end>$2`,
        [sid, index],
      );
      if (!batches.rows.length)
        return {
          batches_rolled_back: 0,
          facts_deleted: 0,
          rewound_cursor: null,
          batch_ids: [],
        };
      const ids = batches.rows.map((r) => String(r.id)),
        rewind = Math.min(...batches.rows.map((r) => Number(r.pair_start)));
      const doomed = await db.query(
        `SELECT id FROM ${this.t()} WHERE session_id=$1 AND batch_id=ANY($2::text[])`,
        [sid, ids],
      );
      const doomedIds = doomed.rows.map((r) => String(r.id));
      if (doomedIds.length) {
        await db.query(
          `UPDATE ${this.t()} SET valid_until_turn=NULL,superseded_by=NULL WHERE session_id=$1 AND superseded_by=ANY($2::text[])`,
          [sid, doomedIds],
        );
        await db.query(
          `DELETE FROM ${this.t()} WHERE session_id=$1 AND id=ANY($2::text[])`,
          [sid, doomedIds],
        );
      }
      const logs = await db.query(
        `SELECT fact_id,prior_reinforcements,prior_last_turn FROM ${this.t("memory_reinforce_log")} WHERE session_id=$1 AND batch_id=ANY($2::text[]) ORDER BY seq`,
        [sid, ids],
      );
      const seen = new Set<string>();
      let restored = 0;
      for (const log of logs.rows) {
        const fid = String(log.fact_id);
        if (seen.has(fid)) continue;
        seen.add(fid);
        const r = await db.query(
          `UPDATE ${this.t()} SET reinforcements=$3,last_turn=$4 WHERE id=$1 AND session_id=$2 RETURNING id`,
          [fid, sid, log.prior_reinforcements, log.prior_last_turn],
        );
        restored += r.rows.length;
      }
      for (const table of ["memory_reinforce_log", "memory_extract_batches"])
        await db.query(
          `DELETE FROM ${this.t(table)} WHERE session_id=$1 AND ${table === "memory_reinforce_log" ? "batch_id" : "id"}=ANY($2::text[])`,
          [sid, ids],
        );
      await this.cursorOn(db, rewind);
      return {
        batches_rolled_back: ids.length,
        facts_deleted: doomedIds.length,
        reinforcements_restored: restored,
        rewound_cursor: rewind,
        batch_ids: ids,
      };
    });
  }
  private async since(db: MemoryDatabase, id: string | null) {
    if (!id) return null;
    const r = await db.query(
      `SELECT turn FROM ${this.t("memory_extract_batches")} WHERE id=$1 AND session_id=$2`,
      [id, this.context.scope.sessionId],
    );
    return r.rows[0] ? Number(r.rows[0].turn) : null;
  }
  async countUnclusteredSince(id: string | null) {
    return this.context.run(async (db) => {
      const turn = await this.since(db, id);
      return Number(
        (
          await db.query(
            `SELECT count(*) AS count FROM ${this.t()} WHERE session_id=$1 AND ($2::integer IS NULL OR valid_from_turn>$2)`,
            [this.context.scope.sessionId, turn],
          )
        ).rows[0]!.count,
      );
    });
  }
  async factsSinceBatch(id: string | null) {
    return this.context.run(async (db) => {
      const turn = await this.since(db, id);
      return (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE session_id=$1 AND ($2::integer IS NULL OR valid_from_turn>$2) ORDER BY valid_from_turn`,
          [this.context.scope.sessionId, turn],
        )
      ).rows.map((r) => this.decode(r));
    });
  }
  async batchIdsSince(id: string | null) {
    return this.context.run(async (db) => {
      const turn = await this.since(db, id);
      return (
        await db.query(
          `SELECT id FROM ${this.t("memory_extract_batches")} WHERE session_id=$1 AND ($2::integer IS NULL OR turn>$2) ORDER BY turn`,
          [this.context.scope.sessionId, turn],
        )
      ).rows.map((r) => String(r.id));
    });
  }
  async purgeSession() {
    return this.context.run(async (db) => {
      for (const table of [
        "memory_facts",
        "memory_extract_cursors",
        "memory_extract_batches",
        "memory_reinforce_log",
        "memory_vectors",
      ])
        await db.query(`DELETE FROM ${this.t(table)} WHERE session_id=$1`, [
          this.context.scope.sessionId,
        ]);
    });
  }
  async getSceneState() {
    return this.context.run(async (db) => {
      const row = (
        await db.query(
          `SELECT char_doing,char_location,known_names FROM ${this.t("sessions")} WHERE id=$1 AND user_id=$2`,
          [this.context.scope.sessionId, this.context.scope.ownerUserId],
        )
      ).rows[0]!;
      return {
        doing: this.context.decrypt(row.char_doing),
        location: this.context.decrypt(row.char_location),
        npcs: JSON.parse(
          this.context.decrypt(row.known_names) || "[]",
        ) as string[],
      };
    });
  }
  async setSceneState(doing: string, location: string, names: string[]) {
    return this.context.run(async (db) => {
      await db.query(
        `UPDATE ${this.t("sessions")} SET char_doing=$3,char_location=$4,known_names=$5 WHERE id=$1 AND user_id=$2`,
        [
          this.context.scope.sessionId,
          this.context.scope.ownerUserId,
          this.context.encrypt(doing),
          this.context.encrypt(location),
          this.context.encrypt(JSON.stringify(names)),
        ],
      );
    });
  }
}
