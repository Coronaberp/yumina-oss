import { RepositoryContext, now } from "./context.js";
export interface LoreVectorHit {
  lore_id: string;
  part_id: number;
  distance: number;
}
export interface SecretVectorHit {
  secret_id: string;
  lore_id: string;
  distance: number;
}
export class VectorsRepository {
  constructor(readonly context: RepositoryContext) {}
  private t(name: string) {
    return this.context.table(name);
  }
  async storeMemory(
    id: string,
    text: string,
    vec: readonly number[],
    ts = now(),
  ) {
    return this.context.run(async (db) => {
      await db.query(
        `INSERT INTO ${this.t("memory_vectors")}(id,session_id,char_id,text,ts,embedding) VALUES($1,$2,$3,$4,$5,$6::vector) ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,embedding=EXCLUDED.embedding WHERE ${this.t("memory_vectors")}.session_id=EXCLUDED.session_id`,
        [
          id,
          this.context.scope.sessionId,
          this.context.scope.charId,
          this.context.encrypt(text),
          ts,
          await this.context.vector(db, vec),
        ],
      );
    });
  }
  async deleteMemory(id: string) {
    return this.context.run(async (db) => {
      await db.query(
        `DELETE FROM ${this.t("memory_vectors")} WHERE id=$1 AND session_id=$2`,
        [id, this.context.scope.sessionId],
      );
    });
  }
  async storeLoreVector(loreId: string, vec: readonly number[], partId = 0) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, loreId);
      const l = (
        await db.query(`SELECT char_id FROM ${this.t("lore")} WHERE id=$1`, [
          loreId,
        ])
      ).rows[0]!;
      await db.query(
        `INSERT INTO ${this.t("lore_vectors")}(lore_id,part_id,char_id,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT(lore_id,part_id) DO UPDATE SET char_id=EXCLUDED.char_id,embedding=EXCLUDED.embedding`,
        [loreId, partId, l.char_id, await this.context.vector(db, vec)],
      );
    });
  }
  async searchLoreChunks(
    vec: readonly number[],
    k: number,
    maxDist: number,
    applyGlobal = false,
  ): Promise<LoreVectorHit[]> {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT v.lore_id,v.part_id,v.embedding <=> $3::vector AS distance FROM ${this.t("lore_vectors")} v JOIN ${this.t("lore")} l ON l.id=v.lore_id WHERE l.owner_id=$1 AND l.usable_as_persona=0 AND (v.char_id=$2 OR ($5 AND v.char_id IS NULL)) ORDER BY distance LIMIT $4`,
        [
          this.context.scope.ownerUserId,
          this.context.scope.charId,
          await this.context.vector(db, vec),
          k,
          applyGlobal,
        ],
      );
      return r.rows
        .filter((r) => Number(r.distance) <= maxDist)
        .map((r) => ({
          lore_id: String(r.lore_id),
          part_id: Number(r.part_id),
          distance: Number(r.distance),
        }));
    });
  }
  async searchLoreIds(
    vec: readonly number[],
    k: number,
    maxDist: number,
    applyGlobal = false,
  ) {
    const hits = await this.searchLoreChunks(vec, k * 4, maxDist, applyGlobal),
      best = new Map<string, number>();
    for (const hit of hits)
      if (!best.has(hit.lore_id) || hit.distance < best.get(hit.lore_id)!)
        best.set(hit.lore_id, hit.distance);
    return [...best]
      .sort((a, b) => a[1] - b[1])
      .slice(0, k)
      .map(([id]) => id);
  }
  async countLoreVectors(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      return Number(
        (
          await db.query(
            `SELECT count(*) AS count FROM ${this.t("lore_vectors")} WHERE lore_id=$1`,
            [id],
          )
        ).rows[0]!.count,
      );
    });
  }
  async deleteLoreVector(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(`DELETE FROM ${this.t("lore_vectors")} WHERE lore_id=$1`, [
        id,
      ]);
    });
  }
  async deleteLoreVectorsByChar() {
    return this.context.run(async (db) => {
      await db.query(`DELETE FROM ${this.t("lore_vectors")} WHERE char_id=$1`, [
        this.context.scope.charId,
      ]);
    });
  }
  async storeSecretVector(
    secretId: string,
    loreId: string,
    vec: readonly number[],
  ) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, loreId);
      const r = await db.query(
        `SELECT l.char_id FROM ${this.t("lore_secrets")} s JOIN ${this.t("lore")} l ON l.id=s.lore_id WHERE s.id=$1 AND s.lore_id=$2`,
        [secretId, loreId],
      );
      if (!r.rows.length) throw new Error("Secret entity not found");
      await db.query(
        `INSERT INTO ${this.t("secret_vectors")}(secret_id,lore_id,char_id,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT(secret_id) DO UPDATE SET lore_id=EXCLUDED.lore_id,char_id=EXCLUDED.char_id,embedding=EXCLUDED.embedding`,
        [
          secretId,
          loreId,
          r.rows[0]!.char_id,
          await this.context.vector(db, vec),
        ],
      );
    });
  }
  async searchSecretIds(
    vec: readonly number[],
    k: number,
    maxDist: number,
    applyGlobal = false,
  ): Promise<SecretVectorHit[]> {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT v.secret_id,v.lore_id,v.embedding <=> $3::vector AS distance FROM ${this.t("secret_vectors")} v JOIN ${this.t("lore")} l ON l.id=v.lore_id WHERE l.owner_id=$1 AND (v.char_id=$2 OR ($5 AND v.char_id IS NULL)) ORDER BY distance LIMIT $4`,
        [
          this.context.scope.ownerUserId,
          this.context.scope.charId,
          await this.context.vector(db, vec),
          k,
          applyGlobal,
        ],
      );
      return r.rows
        .filter((r) => Number(r.distance) <= maxDist)
        .map((r) => ({
          secret_id: String(r.secret_id),
          lore_id: String(r.lore_id),
          distance: Number(r.distance),
        }));
    });
  }
  async deleteSecretVector(id: string) {
    return this.context.run(async (db) => {
      await db.query(
        `DELETE FROM ${this.t("secret_vectors")} v USING ${this.t("lore")} l WHERE v.secret_id=$1 AND l.id=v.lore_id AND l.owner_id=$2 AND (l.char_id=$3 OR l.char_id IS NULL)`,
        [id, this.context.scope.ownerUserId, this.context.scope.charId],
      );
    });
  }
  async deleteSecretVectorsByLore(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(
        `DELETE FROM ${this.t("secret_vectors")} WHERE lore_id=$1`,
        [id],
      );
    });
  }
  async deleteSecretVectorsByChar() {
    return this.context.run(async (db) => {
      await db.query(
        `DELETE FROM ${this.t("secret_vectors")} WHERE char_id=$1`,
        [this.context.scope.charId],
      );
    });
  }
  async storeClusterVector(id: string, vec: readonly number[]) {
    return this.context.run(async (db) => {
      await this.context.requireEntity(db, "memory_clusters", id);
      await db.query(
        `INSERT INTO ${this.t("cluster_vectors")}(cluster_id,session_id,embedding) VALUES($1,$2,$3::vector) ON CONFLICT(cluster_id) DO UPDATE SET embedding=EXCLUDED.embedding WHERE ${this.t("cluster_vectors")}.session_id=EXCLUDED.session_id`,
        [id, this.context.scope.sessionId, await this.context.vector(db, vec)],
      );
    });
  }
  async searchClusterIds(vec: readonly number[], k: number) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT cluster_id,embedding <=> $2::vector AS distance FROM ${this.t("cluster_vectors")} WHERE session_id=$1 ORDER BY distance LIMIT $3`,
        [this.context.scope.sessionId, await this.context.vector(db, vec), k],
      );
      return r.rows.map((r) => ({
        cluster_id: String(r.cluster_id),
        distance: Number(r.distance),
      }));
    });
  }
  async deleteClusterVectors(ids: string[]) {
    return this.context.run(async (db) => {
      await db.query(
        `DELETE FROM ${this.t("cluster_vectors")} WHERE cluster_id=ANY($1::text[]) AND session_id=$2`,
        [ids, this.context.scope.sessionId],
      );
    });
  }
  async purgeSession() {
    return this.context.run(async (db) => {
      for (const t of ["memory_vectors", "cluster_vectors"])
        await db.query(`DELETE FROM ${this.t(t)} WHERE session_id=$1`, [
          this.context.scope.sessionId,
        ]);
    });
  }
  async stats() {
    return this.context.run(async (db) => {
      const mem = await db.query(
        `SELECT count(*) AS count FROM ${this.t("memory_vectors")} WHERE session_id=$1`,
        [this.context.scope.sessionId],
      );
      const lore = await db.query(
        `SELECT count(*) AS count FROM ${this.t("lore_vectors")} v JOIN ${this.t("lore")} l ON l.id=v.lore_id WHERE l.owner_id=$1 AND l.char_id=$2`,
        [this.context.scope.ownerUserId, this.context.scope.charId],
      );
      const secrets = await db.query(
        `SELECT count(*) AS count FROM ${this.t("secret_vectors")} v JOIN ${this.t("lore")} l ON l.id=v.lore_id WHERE l.owner_id=$1 AND l.char_id=$2`,
        [this.context.scope.ownerUserId, this.context.scope.charId],
      );
      return {
        memories: Number(mem.rows[0]!.count),
        lore_vectors: Number(lore.rows[0]!.count),
        secret_vectors: Number(secrets.rows[0]!.count),
        ok: true,
      };
    });
  }
}
