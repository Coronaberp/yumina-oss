import { createMemoryDatabase } from "../src/memory/database.js";
import { ensureRegistry, ensureProfileSchema } from "../src/memory/schema.js";
const url = process.env.MEMORY_DATABASE_URL;
const dataDir = process.env.MEMORY_PGLITE_DATA_DIR;
if (!url && !dataDir)
  throw new Error(
    "Set a dedicated MEMORY_DATABASE_URL or MEMORY_PGLITE_DATA_DIR",
  );
if (url && url === process.env.DATABASE_URL)
  throw new Error("Memory database must be separate");
const db = await createMemoryDatabase({ url, dataDir });
try {
  await ensureRegistry(db);
  const rows = await db.query(
    "SELECT id,user_id,schema_name,dimensions FROM memory_registry.profiles",
  );
  for (const p of rows.rows)
    await ensureProfileSchema(db, {
      id: String(p.id),
      userId: String(p.user_id),
      schemaName: String(p.schema_name),
      dimensions: Number(p.dimensions),
    } as import("../src/memory/types.js").EmbeddingProfile);
} finally {
  await db.close();
}
