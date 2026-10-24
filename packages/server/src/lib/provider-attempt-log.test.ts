import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { db, ensureTables, ensureProviderAttemptTables } from "../db/index.js";
import { providerAttempts, usageLogs, user } from "../db/schema.js";
import { recordProviderAttempt, withProviderAttemptRecording } from "./provider-attempt-log.js";
import { CustomProvider } from "./llm/custom.js";
import type { ProviderAttempt } from "./llm/types.js";

const owner = "attempt-owner";
const receipt: ProviderAttempt = {
  id: "attempt-receipt", invocationId: "invocation", providerHost: "api.cheaperinference.com",
  model: "deepseek-v4.1-flash", conversationId: "play:fixture",
  startedAt: "2026-10-17T00:00:00.000Z", finishedAt: "2026-10-17T00:00:01.000Z",
  status: "complete", httpStatus: 200, providerRequestId: "ci-fixture",
  usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140, reasoningTokens: 30, providerCostUsd: 0.0004 },
};

before(async () => {
  await ensureTables();
  await ensureProviderAttemptTables(); // Additive startup DDL must be repeatable.
  await db.insert(user).values({ id: owner, name: "Fixture", email: "attempt@example.test" });
});

test("attempt receipts persist once, preserve reasoning and cost, and do not create billing rows", async () => {
  await recordProviderAttempt(owner, receipt, "owned-profile");
  await recordProviderAttempt(owner, receipt, "owned-profile");
  const rows = await db.select().from(providerAttempts).where(eq(providerAttempts.id, receipt.id));
  assert.equal(rows.length, 1);
  assert.ok(rows[0]);
  assert.equal(rows[0].userId, owner);
  assert.equal(rows[0].profileId, "owned-profile");
  assert.equal(rows[0].reasoningTokens, 30);
  assert.equal(rows[0].providerCostUsd, "0.000400000000");
  assert.equal(rows[0].providerRequestId, "ci-fixture");
  assert.equal((await db.select().from(usageLogs)).length, 0);
});

test("unknown counts on a failed attempt remain unknown rather than free", async () => {
  await recordProviderAttempt(owner, { ...receipt, id: "unknown-attempt", status: "error", httpStatus: 503, usage: undefined });
  const [row] = await db.select().from(providerAttempts).where(eq(providerAttempts.id, "unknown-attempt"));
  assert.ok(row);
  assert.equal(row.promptTokens, null);
  assert.equal(row.completionTokens, null);
  assert.equal(row.providerCostUsd, null);
});

test("the owned wrapper saves both failed and completed attempts before caller callbacks", async t => {
  let calls = 0;
  let observed = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? new Response("temporary", { status: 503 })
    : Response.json({ choices: [{ message: { content: "[]" } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
  const provider = withProviderAttemptRecording(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), owner, "profile-2");
  for await (const _ of provider.generateStream({
    model: "custom/deepseek-v4.1-flash", messages: [], stream: false,
    onProviderAttempt: async attempt => {
      const [row] = await db.select().from(providerAttempts).where(eq(providerAttempts.id, attempt.id));
      assert.ok(row);
      assert.equal(row.userId, owner);
      assert.equal(row.profileId, "profile-2");
      observed++;
    },
  })) { /* consume */ }
  assert.equal(calls, 2);
  assert.equal(observed, 2);
});

test("ambiguous insert success is retried with the same id and does not duplicate a receipt", async t => {
  const insert = db.insert.bind(db);
  let calls = 0;
  t.mock.method(db, "insert", ((table: any) => ({ values: (values: any) => ({ onConflictDoNothing: async () => {
    await insert(table).values(values).onConflictDoNothing();
    if (++calls === 1) throw new Error("connection lost after commit");
  } }) })) as unknown as typeof db.insert);
  await recordProviderAttempt(owner, { ...receipt, id: "ambiguous-commit" });
  assert.equal(calls, 2);
  assert.equal((await db.select().from(providerAttempts).where(eq(providerAttempts.id, "ambiguous-commit"))).length, 1);
});

test("receipt write failures stop a paid retry instead of silently losing its record", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("temporary", { status: 503 }); });
  t.mock.method(db, "insert", (() => ({ values: () => ({ onConflictDoNothing: async () => {
    throw new Error("database unavailable");
  } }) })) as unknown as typeof db.insert);
  const provider = withProviderAttemptRecording(new CustomProvider("fixture", "https://api.cheaperinference.com/v1"), owner);
  await assert.rejects(async () => {
    for await (const _ of provider.generateStream({ model: "custom/test", messages: [], stream: false })) { /* consume */ }
  }, /request receipt; automatic retry stopped/);
  assert.equal(calls, 1);
});
