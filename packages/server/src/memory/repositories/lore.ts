import type { LoreEntry, MemoryDatabase } from "../types.js";
import { RepositoryContext, nid, now } from "./context.js";
function keysString(keys: string[] = []): string {
  return keys
    .map((key) => key.trim())
    .filter(Boolean)
    .join(",");
}
export interface LoreInput {
  id?: string;
  char_id?: string | null;
  name: string;
  content: string;
  keys?: string[];
  require_keys?: string[];
  exclude_keys?: string[];
  always?: boolean;
  hidden?: boolean;
  category?: string;
  image?: string;
  metadata?: Record<string, unknown>;
  appearance_tags?: string;
  appearance_tags_negative?: string;
  is_explicit?: boolean;
}
export interface StoredLore extends LoreEntry {
  char_id: string | null;
  owner_id: string;
  keys: string[];
  require_keys: string[];
  exclude_keys: string[];
  always: boolean;
  hidden: boolean;
}
export interface LoreChunk {
  id: string;
  lore_id: string;
  part_id: number;
  content: string;
}
export interface LoreSecret {
  id: string;
  text: string;
  position: number;
  lore_id?: string;
}
export interface LoreState {
  session_id: string;
  lore_id: string;
  override_content: string | null;
  override_fact_id: string | null;
  batch_id: string | null;
  prior_override_content: string | null;
  prior_override_fact_id: string | null;
}
export interface LoreLink {
  id: string;
  lore_id_a: string;
  lore_id_b: string;
  label: string;
}
export class LoreRepository {
  constructor(readonly context: RepositoryContext) {}
  private t(name = "lore") {
    return this.context.table(name);
  }
  private decode(r: Record<string, unknown>): StoredLore {
    const c = this.context;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(c.decrypt(r.metadata) || "{}");
      metadata =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {}
    return {
      ...r,
      id: String(r.id),
      char_id: r.char_id as string | null,
      owner_id: String(r.owner_id),
      name: c.decrypt(r.name),
      content: c.decrypt(r.content),
      keys: c.decrypt(r.keys).split(",").filter(Boolean),
      require_keys: String(r.require_keys || "")
        .split(",")
        .filter(Boolean),
      exclude_keys: String(r.exclude_keys || "")
        .split(",")
        .filter(Boolean),
      always: !!r.always,
      always_active: !!r.always,
      hidden: !!r.hidden,
      appearance_tags: c.decrypt(r.appearance_tags),
      appearance_tags_negative: c.decrypt(r.appearance_tags_negative),
      is_explicit: !!r.is_explicit,
      usable_as_persona: !!r.usable_as_persona,
      global: r.char_id === null,
      metadata,
    } as StoredLore;
  }
  private state(r: Record<string, unknown>): LoreState {
    return {
      ...r,
      override_content:
        r.override_content !== null && r.override_content !== undefined
          ? this.context.decrypt(r.override_content)
          : null,
      prior_override_content:
        r.prior_override_content !== null &&
        r.prior_override_content !== undefined
          ? this.context.decrypt(r.prior_override_content)
          : null,
    } as unknown as LoreState;
  }
  async upsert(input: LoreInput) {
    return this.context.run(async (db) => {
      const c = this.context;
      const char = input.char_id === undefined ? c.scope.charId : input.char_id;
      if (char !== null && char !== c.scope.charId)
        throw new Error("Invalid lore character");
      const id = input.id ?? nid("l");
      const existing = await db.query(
        `SELECT owner_id,char_id,content FROM ${this.t()} WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (
        existing.rows.length &&
        (existing.rows[0]!.owner_id !== c.scope.ownerUserId ||
          existing.rows[0]!.char_id !== char)
      )
        throw new Error("Lore ownership conflict");
      const result = await db.query(
        `INSERT INTO ${this.t()} AS target(id,char_id,owner_id,name,content,keys,require_keys,exclude_keys,always,hidden,category,image,metadata,created,appearance_tags,appearance_tags_negative,is_explicit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,content=EXCLUDED.content,keys=EXCLUDED.keys,require_keys=EXCLUDED.require_keys,exclude_keys=EXCLUDED.exclude_keys,always=EXCLUDED.always,hidden=EXCLUDED.hidden,category=EXCLUDED.category,image=EXCLUDED.image,metadata=EXCLUDED.metadata,appearance_tags=EXCLUDED.appearance_tags,appearance_tags_negative=EXCLUDED.appearance_tags_negative,is_explicit=EXCLUDED.is_explicit WHERE target.owner_id=EXCLUDED.owner_id AND target.char_id IS NOT DISTINCT FROM EXCLUDED.char_id RETURNING id`,
        [
          id,
          char,
          c.scope.ownerUserId,
          c.encrypt(input.name),
          c.encrypt(input.content),
          c.encrypt(keysString(input.keys)),
          keysString(input.require_keys),
          keysString(input.exclude_keys),
          input.always ? 1 : 0,
          input.hidden ? 1 : 0,
          input.category ?? "",
          input.image ?? "",
          c.encrypt(JSON.stringify(input.metadata ?? {})),
          Date.now() / 1000,
          c.encrypt(input.appearance_tags ?? ""),
          c.encrypt(input.appearance_tags_negative ?? ""),
          input.is_explicit ? 1 : 0,
        ],
      );
      if (!result.rows.length) throw new Error("Lore ownership conflict");
      if (
        existing.rows.length &&
        c.decrypt(existing.rows[0]!.content) !== input.content
      ) {
        await db.query(
          `DELETE FROM ${this.t("secret_vectors")} WHERE lore_id=$1`,
          [id],
        );
        await db.query(
          `DELETE FROM ${this.t("lore_secrets")} WHERE lore_id=$1`,
          [id],
        );
      }
      return this.decode(
        (await db.query(`SELECT * FROM ${this.t()} WHERE id=$1`, [id]))
          .rows[0]!,
      );
    });
  }
  async get(id: string) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT * FROM ${this.t()} WHERE id=$1 AND owner_id=$2 AND (char_id=$3 OR char_id IS NULL)`,
        [id, this.context.scope.ownerUserId, this.context.scope.charId],
      );
      return r.rows[0] ? this.decode(r.rows[0]) : null;
    });
  }
  async byIds(ids: string[]) {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE id=ANY($1::text[]) AND owner_id=$2 AND (char_id=$3 OR char_id IS NULL)`,
          [ids, this.context.scope.ownerUserId, this.context.scope.charId],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async listForCharacter(applyGlobal = false) {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t()} WHERE owner_id=$1 AND usable_as_persona=0 AND (char_id=$2 OR ($3 AND char_id IS NULL)) ORDER BY always DESC,created DESC`,
          [
            this.context.scope.ownerUserId,
            this.context.scope.charId,
            applyGlobal,
          ],
        )
      ).rows.map((r) => this.decode(r)),
    );
  }
  async delete(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      for (const [table, col] of [
        ["lore_vectors", "lore_id"],
        ["secret_vectors", "lore_id"],
      ])
        await db.query(`DELETE FROM ${this.t(table)} WHERE ${col}=$1`, [id]);
      await db.query(
        `DELETE FROM ${this.t("lore_links")} WHERE lore_id_a=$1 OR lore_id_b=$1`,
        [id],
      );
      await db.query(`DELETE FROM ${this.t()} WHERE id=$1 AND owner_id=$2`, [
        id,
        this.context.scope.ownerUserId,
      ]);
    });
  }
  async chunksFor(id: string): Promise<LoreChunk[]> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      return (
        await db.query(
          `SELECT id,lore_id,part_id,content FROM ${this.t("lore_chunks")} WHERE lore_id=$1 ORDER BY part_id`,
          [id],
        )
      ).rows.map(
        (r) =>
          ({
            ...r,
            content: this.context.decrypt(r.content),
          }) as unknown as LoreChunk,
      );
    });
  }
  async setChunks(id: string, chunks: string[]): Promise<LoreChunk[]> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(`DELETE FROM ${this.t("lore_chunks")} WHERE lore_id=$1`, [
        id,
      ]);
      const out: LoreChunk[] = [];
      for (const [part, content] of chunks.entries()) {
        const row = { id: nid("lchk"), lore_id: id, part_id: part, content };
        await db.query(
          `INSERT INTO ${this.t("lore_chunks")}(id,lore_id,part_id,content,created_ts) VALUES($1,$2,$3,$4,$5)`,
          [row.id, id, part, this.context.encrypt(content), now()],
        );
        out.push(row);
      }
      return out;
    });
  }
  async deleteChunks(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(`DELETE FROM ${this.t("lore_chunks")} WHERE lore_id=$1`, [
        id,
      ]);
    });
  }
  async insertChunk(
    id: string,
    part: number,
    content: string,
  ): Promise<LoreChunk> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      const chunkId = nid("lchk");
      await db.query(
        `INSERT INTO ${this.t("lore_chunks")}(id,lore_id,part_id,content,created_ts) VALUES($1,$2,$3,$4,$5)`,
        [chunkId, id, part, this.context.encrypt(content), now()],
      );
      return { id: chunkId, lore_id: id, part_id: part, content };
    });
  }
  async linksFor(ids: string[]): Promise<LoreLink[]> {
    return this.context.run(
      async (db) =>
        (
          await db.query(
            `SELECT link.id,link.lore_id_a,link.lore_id_b,link.label FROM ${this.t("lore_links")} link JOIN ${this.t()} a ON a.id=link.lore_id_a JOIN ${this.t()} b ON b.id=link.lore_id_b WHERE (link.lore_id_a=ANY($1::text[]) OR link.lore_id_b=ANY($1::text[])) AND a.owner_id=$2 AND b.owner_id=$2 AND (a.char_id=$3 OR a.char_id IS NULL) AND (b.char_id=$3 OR b.char_id IS NULL)`,
            [ids, this.context.scope.ownerUserId, this.context.scope.charId],
          )
        ).rows.map((row) => ({
          ...row,
          label: this.context.decrypt(row.label),
        })) as unknown as LoreLink[],
    );
  }
  async addLink(a: string, b: string, label = "") {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, a);
      await this.context.requireLore(db, b);
      const r = await db.query(
        `INSERT INTO ${this.t("lore_links")}(id,lore_id_a,lore_id_b,label,created) VALUES($1,$2,$3,$4,$5) ON CONFLICT(pair_key) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
        [
          nid("ll"),
          a,
          b,
          this.context.encrypt(Array.from(label.trim()).slice(0, 60).join("")),
          Date.now() / 1000,
        ],
      );
      return String(r.rows[0]!.id);
    });
  }
  async secretsFor(id: string): Promise<LoreSecret[]> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      return (
        await db.query(
          `SELECT id,text,position FROM ${this.t("lore_secrets")} WHERE lore_id=$1 ORDER BY position`,
          [id],
        )
      ).rows.map(
        (r) =>
          ({
            ...r,
            text: this.context.decrypt(r.text),
          }) as unknown as LoreSecret,
      );
    });
  }
  async secretsByIds(ids: string[]): Promise<LoreSecret[]> {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT s.id,s.text,s.position,s.lore_id FROM ${this.t("lore_secrets")} s JOIN ${this.t()} l ON l.id=s.lore_id WHERE s.id=ANY($1::text[]) AND l.owner_id=$2 AND (l.char_id=$3 OR l.char_id IS NULL)`,
          [ids, this.context.scope.ownerUserId, this.context.scope.charId],
        )
      ).rows.map(
        (r) =>
          ({
            ...r,
            text: this.context.decrypt(r.text),
          }) as unknown as LoreSecret,
      ),
    );
  }
  async setSecrets(id: string, texts: string[]): Promise<LoreSecret[]> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(
        `DELETE FROM ${this.t("secret_vectors")} WHERE lore_id=$1`,
        [id],
      );
      await db.query(`DELETE FROM ${this.t("lore_secrets")} WHERE lore_id=$1`, [
        id,
      ]);
      const out: LoreSecret[] = [];
      for (const [position, text] of texts.entries()) {
        const secretId = nid("lsec");
        await db.query(
          `INSERT INTO ${this.t("lore_secrets")}(id,lore_id,text,position,created) VALUES($1,$2,$3,$4,$5)`,
          [
            secretId,
            id,
            this.context.encrypt(text),
            position,
            Date.now() / 1000,
          ],
        );
        out.push({ id: secretId, text, position });
      }
      return out;
    });
  }
  async deleteSecrets(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(
        `DELETE FROM ${this.t("secret_vectors")} WHERE lore_id=$1`,
        [id],
      );
      await db.query(`DELETE FROM ${this.t("lore_secrets")} WHERE lore_id=$1`, [
        id,
      ]);
    });
  }
  async getState(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      const r = await db.query(
        `SELECT * FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND lore_id=$2`,
        [this.context.scope.sessionId, id],
      );
      return r.rows[0] ? this.state(r.rows[0]) : null;
    });
  }
  async setOverride(
    id: string,
    content: string,
    factId: string | null,
    batchId?: string | null,
  ) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      if (factId) await this.context.requireEntity(db, "memory_facts", factId);
      await this.context.requireBatchScope(db, batchId);
      const sid = this.context.scope.sessionId;
      const r = await db.query(
        `SELECT * FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND lore_id=$2 FOR UPDATE`,
        [sid, id],
      );
      const existing = r.rows[0];
      let priorContent = existing?.prior_override_content ?? null,
        priorFact = existing?.prior_override_fact_id ?? null;
      if (!batchId) {
        priorContent = null;
        priorFact = null;
      } else if (existing && existing.batch_id !== batchId) {
        priorContent = existing.override_content ?? null;
        priorFact = existing.override_fact_id ?? null;
      }
      await db.query(
        `INSERT INTO ${this.t("session_lore_state")}(id,session_id,lore_id,override_content,override_fact_id,batch_id,prior_override_content,prior_override_fact_id,updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(session_id,lore_id) DO UPDATE SET override_content=EXCLUDED.override_content,override_fact_id=EXCLUDED.override_fact_id,batch_id=EXCLUDED.batch_id,prior_override_content=EXCLUDED.prior_override_content,prior_override_fact_id=EXCLUDED.prior_override_fact_id,updated=EXCLUDED.updated`,
        [
          nid("sls"),
          sid,
          id,
          this.context.encrypt(content),
          factId,
          batchId ?? null,
          priorContent,
          priorFact,
          Date.now() / 1000,
        ],
      );
    });
  }
  async statesForBatches(ids: string[]): Promise<LoreState[]> {
    return this.context.run(async (db) =>
      (
        await db.query(
          `SELECT * FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND batch_id=ANY($2::text[])`,
          [this.context.scope.sessionId, ids],
        )
      ).rows.map((r) => this.state(r)),
    );
  }
  async restorePrior(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(
        `UPDATE ${this.t("session_lore_state")} SET override_content=prior_override_content,override_fact_id=prior_override_fact_id,prior_override_content=NULL,prior_override_fact_id=NULL,batch_id=NULL,updated=$3 WHERE session_id=$1 AND lore_id=$2`,
        [this.context.scope.sessionId, id, Date.now() / 1000],
      );
    });
  }
  async deleteState(id: string) {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      await db.query(
        `DELETE FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND lore_id=$2`,
        [this.context.scope.sessionId, id],
      );
    });
  }
  async clearOverride(id: string): Promise<string | null> {
    return this.context.run(async (db) => {
      await this.context.requireLore(db, id);
      const r = await db.query(
        `SELECT override_fact_id FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND lore_id=$2`,
        [this.context.scope.sessionId, id],
      );
      const factId = r.rows[0]?.override_fact_id;
      if (!factId) return null;
      await db.query(
        `UPDATE ${this.t("session_lore_state")} SET override_content=NULL,override_fact_id=NULL,batch_id=NULL,prior_override_content=NULL,prior_override_fact_id=NULL,updated=$3 WHERE session_id=$1 AND lore_id=$2`,
        [this.context.scope.sessionId, id, Date.now() / 1000],
      );
      return String(factId);
    });
  }
  async getAllOverridesForSession(): Promise<Record<string, string>> {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT lore_id,override_content FROM ${this.t("session_lore_state")} WHERE session_id=$1 AND override_content IS NOT NULL`,
        [this.context.scope.sessionId],
      );
      return Object.fromEntries(
        r.rows.map((r) => [
          String(r.lore_id),
          this.context.decrypt(r.override_content),
        ]),
      );
    });
  }
  async reveal(
    secretId: string,
    batchId?: string | null,
    factId?: string | null,
  ) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `SELECT s.id FROM ${this.t("lore_secrets")} s JOIN ${this.t()} l ON l.id=s.lore_id WHERE s.id=$1 AND l.owner_id=$2 AND (l.char_id=$3 OR l.char_id IS NULL)`,
        [secretId, this.context.scope.ownerUserId, this.context.scope.charId],
      );
      if (!r.rows.length) throw new Error("Secret entity not found");
      if (factId) await this.context.requireEntity(db, "memory_facts", factId);
      await this.context.requireBatchScope(db, batchId);
      await db.query(
        `INSERT INTO ${this.t("session_secret_reveals")}(id,session_id,secret_id,revealed,batch_id,fact_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,secret_id) DO NOTHING`,
        [
          nid("ssr"),
          this.context.scope.sessionId,
          secretId,
          Date.now() / 1000,
          batchId ?? null,
          factId ?? null,
        ],
      );
    });
  }
  async revealedIds(ids: string[]): Promise<Set<string>> {
    return this.context.run(
      async (db) =>
        new Set(
          (
            await db.query(
              `SELECT secret_id FROM ${this.t("session_secret_reveals")} WHERE session_id=$1 AND secret_id=ANY($2::text[])`,
              [this.context.scope.sessionId, ids],
            )
          ).rows.map((r) => String(r.secret_id)),
        ),
    );
  }
  async deleteRevealsForBatches(ids: string[]) {
    return this.context.run(async (db) => {
      const r = await db.query(
        `DELETE FROM ${this.t("session_secret_reveals")} WHERE session_id=$1 AND batch_id=ANY($2::text[]) RETURNING fact_id`,
        [this.context.scope.sessionId, ids],
      );
      const facts = r.rows.flatMap((r) =>
        r.fact_id ? [String(r.fact_id)] : [],
      );
      if (facts.length)
        await db.query(
          `DELETE FROM ${this.t("memory_facts")} WHERE session_id=$1 AND id=ANY($2::text[])`,
          [this.context.scope.sessionId, facts],
        );
      return r.rows.length;
    });
  }
  async purgeSession() {
    return this.context.run(async (db) => {
      for (const table of ["session_lore_state", "session_secret_reveals"])
        await db.query(`DELETE FROM ${this.t(table)} WHERE session_id=$1`, [
          this.context.scope.sessionId,
        ]);
    });
  }
}
