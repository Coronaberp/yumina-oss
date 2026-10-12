import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { invalidateExtensionsCache } from "./extensions.js";

/** Install platform defaults once; later explicit uninstalls remain user choices. */
export async function installDefaultExtensions(userId?: string): Promise<string[]> {
  const installed = await db.transaction(async tx => {
    const rows = (await tx.execute(sql`
      INSERT INTO user_extensions(id,user_id,extension_key,status)
      SELECT gen_random_uuid()::text,id,'state-update-guard','installed' FROM "user"
      WHERE ${userId === undefined ? sql`TRUE` : sql`id=${userId}`}
      ON CONFLICT(user_id,extension_key) DO NOTHING
      RETURNING user_id
    `)).rows;
    if (rows.length) await tx.execute(sql`
      INSERT INTO extension_stats(extension_key,download_count,updated_at)
      VALUES('state-update-guard',${rows.length},NOW())
      ON CONFLICT(extension_key) DO UPDATE SET
        download_count=extension_stats.download_count+EXCLUDED.download_count,updated_at=NOW()
    `);
    return rows.map(row => String(row.user_id));
  });
  for (const owner of installed) invalidateExtensionsCache(owner);
  return installed;
}
