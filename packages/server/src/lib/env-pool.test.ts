import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";

const file = new URL("./env.ts", import.meta.url);
const require = createRequire(file);
const source = transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code;
function readEnv(input: Record<string, string>) {
  const module = { exports: {} as { EDITION: string; env: { DATABASE_POOL_MAX: number } } };
  new Function("require", "module", "exports", "process", source)(
    (id: string) => id === "dotenv" ? { config: () => {} } : require(id), module, module.exports,
    { env: { BETTER_AUTH_SECRET: "isolated-pool-test", ...input }, exit: () => { throw new Error("Invalid test environment"); } },
  );
  return module.exports;
}
test("local connections leave room for memory and maintenance; hosted defaults remain unchanged", () => {
  assert.equal(readEnv({ YUMINA_EDITION: "local" }).env.DATABASE_POOL_MAX, 10);
  assert.equal(readEnv({ YUMINA_EDITION: "hosted" }).env.DATABASE_POOL_MAX, 100);
  const fallback = readEnv({});
  assert.equal(fallback.EDITION, "hosted");
  assert.equal(fallback.env.DATABASE_POOL_MAX, 100);
  for (const edition of ["local", "hosted"]) {
    assert.equal(readEnv({ YUMINA_EDITION: edition, DATABASE_POOL_MAX: "17" }).env.DATABASE_POOL_MAX, 17);
  }
});
