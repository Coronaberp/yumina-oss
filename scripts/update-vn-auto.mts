/** Guarded Auto-only refresh of the reference card owner's VN roots and saved cuts.
 * Dry-run by default. Run --apply only while holding the coordinated release lock. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { bundleTSX } from "../packages/app/src/features/studio/lib/tsx-bundler";
import { hashRootFiles, COMPILED_FORMAT_VERSION } from "../packages/app/src/features/studio/lib/compiled-format";
import { upgradeVnAutoFiles } from "../packages/app/src/features/chat/vn-auto-upgrade";

const autoSource = readFileSync(new URL("../interfaces/vn/auto-reading.ts", import.meta.url), "utf8");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const referenceId = args.find(arg => /^[\da-f-]{36}$/i.test(arg));
if (!referenceId || args.some(arg => arg !== referenceId && arg !== "--apply")) throw new Error("Pass the reference world UUID and optional --apply.");
const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const env = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; this updater does not open embedded save data.");
const client = new (require("pg").Client)({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  const reference = (await client.query("SELECT creator_id FROM worlds WHERE id=$1", [referenceId])).rows[0];
  if (!reference) throw new Error("Reference world not found.");
  const worlds = (await client.query("SELECT id,name,creator_id,schema,editing_locked,updated_at::text AS revision FROM worlds WHERE creator_id=$1 ORDER BY id", [reference.creator_id])).rows;
  const results = [];
  for (const world of worlds) {
    const schema = structuredClone(world.schema);
    const changed: Array<{ root: string; files: string[] }> = [];
    const preserved: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Saved root schema is validated by its existing compiler.
    function upgrade(root: any, label: string) {
      if (!root?.files) return root;
      const files = upgradeVnAutoFiles(root.files, autoSource);
      if (files === root.files) {
        if (Object.values(root.files).some(source => typeof source === "string" && source.includes('<Control name="Auto"'))) preserved.push(label);
        return root;
      }
      const compiled = bundleTSX({ files, entryFile: root.entryFile });
      if (compiled.error || !compiled.code) throw new Error(`${world.id} ${label}: ${compiled.error || "Empty bundle"}`);
      changed.push({ root: label, files: Object.keys(files).filter(key => files[key] !== root.files[key]) });
      return { ...root, files, updatedAt: new Date().toISOString(), compiled: { code: compiled.code, filesHash: hashRootFiles(root.entryFile, files), compilerVersion: COMPILED_FORMAT_VERSION } };
    }
    if (schema.rootComponent) schema.rootComponent = upgrade(schema.rootComponent, "active");
    for (const [name, root] of Object.entries(schema.interfaceDrafts ?? {})) schema.interfaceDrafts[name] = upgrade(root, `saved:${name}`);
    if (!changed.length) {
      if (preserved.length) results.push({ id: world.id, name: world.name, changed, preserved });
      continue;
    }
    const before = { ...world.schema }, after = { ...schema };
    delete before.rootComponent; delete before.interfaceDrafts;
    delete after.rootComponent; delete after.interfaceDrafts;
    if (!isDeepStrictEqual(before, after)) throw new Error(`${world.id}: unexpected non-interface schema change.`);
    let backup: string | undefined;
    if (apply) {
      const folder = process.env.YUMINA_VN_BACKUP_DIR || new URL("../output/vn-auto-release/", import.meta.url).pathname;
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      backup = join(folder, `${world.id}-${Date.now()}.json`);
      writeFileSync(backup, JSON.stringify(world), { mode: 0o600 });
      const saved = await client.query("UPDATE worlds SET schema=$1,updated_at=now() WHERE id=$2 AND creator_id=$3 AND updated_at::text=$4 RETURNING schema,editing_locked", [schema, world.id, world.creator_id, world.revision]);
      if (saved.rowCount !== 1 || !isDeepStrictEqual(saved.rows[0].schema, schema) || saved.rows[0].editing_locked !== world.editing_locked) throw new Error(`${world.id}: concurrent edit or saved schema/lock mismatch; rolling back.`);
    }
    results.push({ id: world.id, name: world.name, changed, preserved, locked: world.editing_locked, backup });
  }
  await client.query(apply ? "COMMIT" : "ROLLBACK");
  console.log(JSON.stringify({ apply, referenceId, examined: worlds.length, changedCards: results.filter(row => row.changed.length).length, results }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
