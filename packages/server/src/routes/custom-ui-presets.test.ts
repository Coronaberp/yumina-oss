import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Hono, Context } from "hono";
import type { AppEnv } from "../lib/types.js";
import { CUSTOM_UI_PRESETS_DDL } from "../db/custom-ui-presets-ddl.js";

const client = new PGlite();
let owner = "alice";
const file = new URL("./custom-ui-presets.ts", import.meta.url);
const require = createRequire(file);
const module = { exports: {} as { customUiPresetRoutes: Hono<AppEnv> } };
const mocks: Record<string, unknown> = {
  "../db/index.js": { db: drizzle(client) },
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (!owner) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next();
  } },
};
new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
const routes = module.exports.customUiPresetRoutes;
before(async () => { await client.exec('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\');'); await client.exec(CUSTOM_UI_PRESETS_DDL); });
after(async () => client.close());
const post = (body: object) => routes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const preset = { id: "9c4bef02-1f23-4548-a54f-848c6a90e600", name: "😀".repeat(60), entryFile: "index.tsx", files: { "index.tsx": "export default function UI(){return <Chat/>}", "sprites.ts": "saved config" } };
test("account library truncates to 50 characters, persists every file and scopes access", async () => {
  owner = "alice";
  const saved = await post(preset); assert.equal(saved.status, 201, await saved.clone().text());
  const { data } = await saved.json() as any;
  assert.equal(data.name, "😀".repeat(50)); assert.deepEqual(data.files, preset.files); assert.equal(data.compiled, undefined);
  assert.equal((await routes.request("/")).headers.get("cache-control"), "no-store");
  assert.equal((await (await routes.request("/")).json() as any).data.length, 1);
  assert.equal((await post(preset)).status, 201, "retrying same save ID is idempotent");
  owner = "bob";
  assert.equal((await (await routes.request("/")).json() as any).data.length, 0);
  assert.equal((await routes.request("/" + data.id, { method: "DELETE" })).status, 404);
  assert.equal((await post(preset)).status, 409, "cannot reuse another owner's ID");
  owner = "alice";
  assert.equal((await routes.request("/" + data.id, { method: "DELETE" })).status, 200);
  assert.equal((await (await routes.request("/")).json() as any).data.length, 0);
  owner = "";
  assert.equal((await routes.request("/")).status, 401);
});
test("rejects empty names, missing entries, unsafe paths and oversized file content", async () => {
  owner = "alice";
  for (const invalid of [
    { ...preset, name: "   " }, { ...preset, entryFile: "missing.tsx" },
    { ...preset, files: { "../index.tsx": "code" }, entryFile: "../index.tsx" },
    { ...preset, files: { "index.tsx": "x".repeat(2 * 1024 * 1024 + 1) } },
  ]) assert.equal((await post(invalid)).status, 400);
});
