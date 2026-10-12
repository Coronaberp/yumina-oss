import { randomUUID } from "node:crypto";
import type { EmbeddingProfile, MemoryDatabase } from "./types.js";
import { validateDimensions } from "./schema.js";
export interface ProfileInput {
  baseUrl: string;
  model: string;
  dimensions: number;
  sendDimensions?: boolean;
  apiKey?: string;
}
export interface CredentialCipher {
  encrypt: (text: string) => string;
  decrypt: (token: string) => string;
}
export interface AdminEmbeddingDefault {
  /** Server-only resolver must verify the installation's pinned admin role. */
  source(database?: MemoryDatabase): Promise<EmbeddingProfile | null>;
  prepare(profile: EmbeddingProfile): Promise<void>;
}
function sameConnection(a: EmbeddingProfile, b: EmbeddingProfile) {
  return a.baseUrl === b.baseUrl && a.model === b.model && a.dimensions === b.dimensions && a.sendDimensions === b.sendDimensions;
}
function decode(r: Record<string, unknown>): EmbeddingProfile {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    schemaName: r.schema_name as string,
    baseUrl: r.base_url as string,
    model: r.model as string,
    dimensions: Number(r.dimensions),
    sendDimensions: r.send_dimensions as boolean,
    status: r.status as EmbeddingProfile["status"],
    revision: Number(r.revision),
    active: r.active as boolean,
    errorCode: r.error_code as string | null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(typeof r.inherited_from === "string" ? { inheritedFrom: r.inherited_from } : {}),
  };
}
export const PROFILE_ERROR_CODES = [
  "embedding_unavailable",
  "embedding_invalid",
  "embedding_dimension_mismatch",
  "reindex_failed",
  "profile_unavailable",
  "validation_failed",
] as const;
export class ProfileRepository {
  private resolvingDefaults = new Map<string, Promise<EmbeddingProfile | null>>();
  constructor(
    private db: MemoryDatabase,
    private cipher: CredentialCipher,
    private adminDefault?: AdminEmbeddingDefault,
  ) {}
  async list(userId: string) {
    return (
      await this.db.query(
        "SELECT * FROM memory_registry.profiles WHERE user_id=$1 ORDER BY created_at,id",
        [userId],
      )
    ).rows.map(decode);
  }
  async get(userId: string, id: string) {
    const r = await this.db.query(
      "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND id=$2",
      [userId, id],
    );
    return r.rows[0] ? decode(r.rows[0]) : null;
  }
  async getOwnActive(userId: string, database: MemoryDatabase = this.db) {
    const r = await database.query(
      "SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND active",
      [userId],
    );
    return r.rows[0] ? decode(r.rows[0]) : null;
  }
  async getActive(userId: string): Promise<EmbeddingProfile | null> {
    if (!this.adminDefault) return this.getOwnActive(userId);
    const pending = this.resolvingDefaults.get(userId);
    if (pending) return pending;
    const work = this.resolveDefault(userId).finally(() => this.resolvingDefaults.delete(userId));
    this.resolvingDefaults.set(userId, work);
    return work;
  }
  private async resolveDefault(userId: string): Promise<EmbeddingProfile | null> {
    const own = await this.getOwnActive(userId);
    // Activation is the explicit override, even if its connection later fails.
    if (own && !own.inheritedFrom) return own;
    const source = await this.adminDefault!.source();
    if (!source || source.status !== "ready" || !source.active) return null;
    if (own) {
      if (!sameConnection(own, source)) return { ...own, adminDefaultUpdateAvailable: true };
      // Refresh before callers capture ciphertext for worker/recall fencing.
      // getCredential stays read-only. Avoid writes on every ordinary lookup.
      await this.db.query(`UPDATE memory_registry.profiles child SET credential=parent.credential,inherited_from=parent.id,updated_at=now()
        FROM memory_registry.profiles parent WHERE child.user_id=$1 AND child.id=$2 AND child.active AND child.inherited_from IS NOT NULL
        AND parent.id=$3 AND parent.active AND parent.status='ready'
        AND (child.credential IS DISTINCT FROM parent.credential OR child.inherited_from IS DISTINCT FROM parent.id)`, [userId, own.id, source.id]);
      return this.getOwnActive(userId);
    }
    const target = await this.prepareAdminDefault(userId);
    if (!target) return null;
    return this.db.transaction(async tx => {
      const owner = (await tx.query("SELECT deleted FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if (!owner || owner.deleted) throw new Error("Memory owner deleted");
      const repository = new ProfileRepository(tx, this.cipher);
      const current = await repository.getOwnActive(userId);
      if (current) return current; // A concurrent personal activation wins.
      const liveSource = await this.adminDefault!.source(tx);
      if (!liveSource || !sameConnection(target, liveSource) || target.inheritedFrom !== liveSource.id) return null;
      if (!(await this.inheritedSourceCurrent(target, tx))) return null;
      await repository.activate(userId, target.id, target.revision);
      return repository.getOwnActive(userId);
    });
  }
  /** Prepare private storage only; an existing active profile needs explicit reindex. */
  async prepareAdminDefault(userId: string): Promise<EmbeddingProfile | null> {
    const source = await this.adminDefault?.source();
    if (!source || source.status !== "ready" || !source.active) return null;
    const target = await this.db.transaction(async tx => {
      await tx.query("INSERT INTO memory_registry.profile_owners(user_id,next_revision) VALUES($1,0) ON CONFLICT DO NOTHING", [userId]);
      const owner = (await tx.query("SELECT deleted FROM memory_registry.profile_owners WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if (!owner || owner.deleted) throw new Error("Memory owner deleted");
      const parent = (await tx.query("SELECT * FROM memory_registry.profiles WHERE id=$1 AND user_id=$2 AND active AND status='ready' FOR SHARE", [source.id, source.userId])).rows[0];
      if (!parent || !sameConnection(decode(parent), source)) throw new Error("Admin embedding default changed");
      const existing = (await tx.query(`SELECT * FROM memory_registry.profiles WHERE user_id=$1 AND inherited_from=$2
        AND base_url=$3 AND model=$4 AND dimensions=$5 AND send_dimensions=$6 ORDER BY created_at DESC,id LIMIT 1`,
        [userId, source.id, source.baseUrl, source.model, source.dimensions, source.sendDimensions])).rows[0];
      if (existing) {
        const refreshed = (await tx.query(`UPDATE memory_registry.profiles SET credential=$3,updated_at=CASE WHEN credential IS DISTINCT FROM $3 THEN now() ELSE updated_at END WHERE user_id=$1 AND id=$2 RETURNING *`, [userId, existing.id, parent.credential])).rows[0]!;
        return decode(refreshed);
      }
      const id = randomUUID();
      const revision = (await tx.query<{ next_revision: number }>("UPDATE memory_registry.profile_owners SET next_revision=next_revision+1 WHERE user_id=$1 RETURNING next_revision", [userId])).rows[0]!.next_revision;
      const row = (await tx.query(`INSERT INTO memory_registry.profiles(id,user_id,schema_name,base_url,model,dimensions,send_dimensions,status,revision,credential,inherited_from)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING *`,
        [id, userId, `shm_${id.replaceAll("-", "")}`, source.baseUrl, source.model, source.dimensions, source.sendDimensions, revision, parent.credential, source.id])).rows[0]!;
      return decode(row);
    });
    await this.adminDefault!.prepare(target);
    if (target.status === "pending") await this.setStatus(userId, target.id, "ready");
    return this.get(userId, target.id);
  }
  async inheritedSourceCurrent(profile: EmbeddingProfile, database: MemoryDatabase = this.db): Promise<boolean> {
    if (!profile.inheritedFrom) return true;
    const source = await this.adminDefault?.source(database);
    if (!source || source.id !== profile.inheritedFrom || !sameConnection(source, profile)) return false;
    const rows = (await database.query("SELECT id FROM memory_registry.profiles WHERE id=$1 AND active AND status='ready' AND credential IS NOT DISTINCT FROM (SELECT credential FROM memory_registry.profiles WHERE id=$2 AND user_id=$3) FOR SHARE", [source.id, profile.id, profile.userId])).rows;
    return rows.length === 1;
  }
  async isActiveInheritedSource(profile: EmbeddingProfile, database: MemoryDatabase = this.db): Promise<boolean> {
    const current = await this.getOwnActive(profile.userId, database);
    return !!current?.inheritedFrom && current.id === profile.id;
  }
  async create(userId: string, input: ProfileInput) {
    validateDimensions(input.dimensions);
    if (!userId || !input.model.trim()) throw new Error("Invalid profile");
    const url = new URL(input.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid embedding endpoint");
    const id = randomUUID();
    const schema = `shm_${id.replaceAll("-", "")}`;
    return this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO memory_registry.profile_owners(user_id,next_revision) VALUES($1,0) ON CONFLICT DO NOTHING",
        [userId],
      );
      const rev = await tx.query<{ next_revision: number }>(
        "UPDATE memory_registry.profile_owners SET next_revision=next_revision+1 WHERE user_id=$1 AND NOT deleted RETURNING next_revision",
        [userId],
      );
      if (!rev.rows.length) throw new Error("Memory owner deleted");
      const r = await tx.query(
        `INSERT INTO memory_registry.profiles(id,user_id,schema_name,base_url,model,dimensions,send_dimensions,status,revision,credential) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
        [
          id,
          userId,
          schema,
          input.baseUrl,
          input.model,
          input.dimensions,
          input.sendDimensions ?? false,
          rev.rows[0]!.next_revision,
          input.apiKey ? this.cipher.encrypt(input.apiKey) : null,
        ],
      );
      return decode(r.rows[0]!);
    });
  }
  async setStatus(
    userId: string,
    id: string,
    status: EmbeddingProfile["status"],
    error?: string,
  ) {
    if (!["pending", "ready", "failed"].includes(status))
      throw new Error("Invalid profile status");
    if (
      error &&
      !PROFILE_ERROR_CODES.includes(
        error as (typeof PROFILE_ERROR_CODES)[number],
      )
    )
      error = "validation_failed";
    const r = await this.db.query(
      `UPDATE memory_registry.profiles SET status=$3,error_code=$4,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING id`,
      [userId, id, status, error ?? null],
    );
    if (!r.rows.length) throw new Error("Profile not found");
  }
  async activate(userId: string, id: string, expectedRevision: number) {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM memory_registry.profiles WHERE user_id=$1 ORDER BY id FOR UPDATE",
        [userId],
      );
      const target = await tx.query(
        `SELECT id FROM memory_registry.profiles WHERE user_id=$1 AND id=$2 AND revision=$3 AND status='ready'`,
        [userId, id, expectedRevision],
      );
      if (!target.rows.length) throw new Error("Profile activation conflict");
      await tx.query(
        "UPDATE memory_registry.profiles SET active=false WHERE user_id=$1 AND active",
        [userId],
      );
      await tx.query(
        "UPDATE memory_registry.profiles SET active=true,updated_at=now() WHERE user_id=$1 AND id=$2",
        [userId, id],
      );
    });
  }
  async getCredential(userId: string, id: string) {
    const r = await this.db.query<{ credential: string | null }>(
      "SELECT credential FROM memory_registry.profiles WHERE user_id=$1 AND id=$2",
      [userId, id],
    );
    if (!r.rows.length) throw new Error("Profile not found");
    return r.rows[0]!.credential
      ? this.cipher.decrypt(r.rows[0]!.credential)
      : "";
  }
  async updateKey(userId: string, id: string, key: string) {
    if ((await this.get(userId, id))?.inheritedFrom) throw new Error("The admin manages this embedding default");
    const r = await this.db.query(
      "UPDATE memory_registry.profiles SET credential=$3,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING id",
      [userId, id, key ? this.cipher.encrypt(key) : null],
    );
    if (!r.rows.length) throw new Error("Profile not found");
  }
}
