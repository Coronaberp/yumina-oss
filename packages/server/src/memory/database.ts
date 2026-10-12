import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import pg from "pg";
import type { MemoryDatabase } from "./types.js";
export interface MemoryDatabaseOptions {
  url?: string;
  dataDir?: string;
}
/** This factory never reads the application DATABASE_URL. */
export async function createMemoryDatabase(
  options: MemoryDatabaseOptions = {},
): Promise<MemoryDatabase> {
  if (options.url && options.dataDir)
    throw new Error("Choose one memory database");
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url });
    let savepoint = 0;
    const wrap = (client: pg.Pool | pg.PoolClient): MemoryDatabase => ({
      async query(sql, values) {
        const r = await client.query(sql, values);
        return { rows: r.rows };
      },
      async transaction(work) {
        const outer = client === pool;
        const conn = outer ? await pool.connect() : (client as pg.PoolClient);
        const name = `memory_sp_${++savepoint}`;
        await conn.query(outer ? "BEGIN" : `SAVEPOINT ${name}`);
        try {
          const result = await work(wrap(conn));
          await conn.query(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (e) {
          await conn.query(
            outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`,
          );
          if (!outer) await conn.query(`RELEASE SAVEPOINT ${name}`);
          throw e;
        } finally {
          if (outer) conn.release();
        }
      },
      async close() {
        if (client === pool) await pool.end();
      },
    });
    return wrap(pool);
  }
  const lite = new PGlite(options.dataDir ?? "memory://", {
    extensions: { vector },
  });
  await lite.waitReady;
  let savepoint = 0;
  type QueryClient = Pick<PGlite, "query">;
  const wrap = (conn: QueryClient): MemoryDatabase => ({
    async query<T extends Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      const r = await conn.query<T>(sql, values);
      return { rows: r.rows };
    },
    async transaction(work) {
      if (conn === lite)
        return lite.transaction(async (tx) =>
          work(wrap(tx as unknown as QueryClient)),
        );
      const name = `memory_sp_${++savepoint}`;
      await conn.query(`SAVEPOINT ${name}`);
      try {
        const result = await work(wrap(conn));
        await conn.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (e) {
        await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await conn.query(`RELEASE SAVEPOINT ${name}`);
        throw e;
      }
    },
    async close() {
      if (conn === lite) await lite.close();
    },
  });
  return wrap(lite);
}
