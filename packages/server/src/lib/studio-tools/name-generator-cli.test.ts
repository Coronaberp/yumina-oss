import assert from "node:assert/strict";
import { test } from "node:test";

test("the generator can produce constrained full names from a command line without an LLM", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("CLI generation must be local"); });
  const modulePath = "./name-generator-cli.js";
  const implementation = await import(modulePath).catch(() => null);
  assert.ok(implementation, "A direct generator CLI must be available");
  const args = ["--style", "romance", "--count", "3", "--format", "full", "--surname", "Vale", "--particle", "de", "--order", "family-given", "--seed", "cli", "--json"];
  const output = await implementation.generateNameCli(args);
  const result = JSON.parse(output);
  assert.equal(result.names.length, 3);
  assert.ok(result.names.every((name: string) => name.startsWith("de Vale ")));
  assert.equal(await implementation.generateNameCli(args), output);
});
