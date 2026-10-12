import { randomUUID } from "node:crypto";
import { encryptMemoryText, decryptMemoryText } from "../crypto.js";
import { quoteSchema, validateScope } from "../schema.js";
import type { MemoryDatabase, MemoryScope } from "../types.js";
export type MemoryKey = string | Uint8Array;
export function nid(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
export const now = () => Math.floor(Date.now() / 1000);
export class RepositoryContext {
  readonly schema: string;
  constructor(
    readonly db: MemoryDatabase,
    readonly scope: MemoryScope,
    readonly key: MemoryKey,
  ) {
    this.schema = quoteSchema(scope.schemaName);
    this.scope = Object.freeze({ ...scope });
    this.key = typeof key === "string" ? key : Uint8Array.from(key);
  }
  table(name: string) {
    return `${this.schema}.${name}`;
  }
  encrypt(text: string) {
    return encryptMemoryText(text, this.key);
  }
  decrypt(text: unknown) {
    return decryptMemoryText(String(text ?? ""), this.key);
  }
  async run<T>(work: (db: MemoryDatabase) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await validateScope(tx, this.scope);
      return work(tx);
    });
  }
  async vector(db: MemoryDatabase, values: readonly number[]): Promise<string> {
    const r = await db.query<{ dimensions: number }>(
      "SELECT dimensions FROM memory_registry.profiles WHERE id=$1 AND user_id=$2",
      [this.scope.profileId, this.scope.ownerUserId],
    );
    const dim = Number(r.rows[0]?.dimensions);
    if (values.length !== dim || !values.every(Number.isFinite))
      throw new Error("Invalid embedding vector");
    const vec = values.map(Math.fround);
    if (!vec.every(Number.isFinite) || !vec.some((n) => n !== 0))
      throw new Error("Invalid embedding vector");
    return JSON.stringify(vec);
  }
  async requireBatchScope(
    db: MemoryDatabase,
    batchId?: string | null,
  ): Promise<void> {
    if (!batchId) return;
    const result = await db.query(
      `SELECT session_id FROM ${this.table("memory_extract_batches")} WHERE id=$1`,
      [batchId],
    );
    if (
      result.rows.length &&
      result.rows[0]!.session_id !== this.scope.sessionId
    )
      throw new Error("Invalid memory batch scope");
  }
  async requireEntity(
    db: MemoryDatabase,
    table: string,
    id: string,
    column = "id",
  ): Promise<void> {
    const r = await db.query(
      `SELECT ${column} FROM ${this.table(table)} WHERE ${column}=$1 AND session_id=$2`,
      [id, this.scope.sessionId],
    );
    if (!r.rows.length) throw new Error("Memory entity not found");
  }
  async requireLore(db: MemoryDatabase, id: string): Promise<void> {
    const r = await db.query(
      `SELECT id FROM ${this.table("lore")} WHERE id=$1 AND owner_id=$2 AND (char_id=$3 OR char_id IS NULL)`,
      [id, this.scope.ownerUserId, this.scope.charId],
    );
    if (!r.rows.length) throw new Error("Lore entity not found");
  }
}
