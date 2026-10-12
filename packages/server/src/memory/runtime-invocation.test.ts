import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import { ensureRegistry } from "./schema.js";
import { createRecordedMemoryModel } from "./runtime.js";
import type { StreamChunk } from "../lib/llm/types.js";
for (const result of ["complete", "failed", "cancelled"] as const)
  test(`actual ${result} invocation persists a unique receipt without inventing missing measurements`, async () => {
    const db = await createMemoryDatabase();
    try {
      await ensureRegistry(db);
      const controller = new AbortController();
      const model = createRecordedMemoryModel({
        database: db,
        userId: "actor",
        sessionId: "s",
        model: "m",
        apiKeyTier: "byok",
        provider: {
          async *generateStream() {
            const started = await db.query(
              "SELECT status FROM memory_registry.model_invocations",
            );
            assert.equal(started.rows[0]!.status, "started");
            yield { type: "text", content: "partial" } as StreamChunk;
            if (result === "cancelled") {
              controller.abort();
              throw new Error("cancelled");
            }
            if (result === "failed") throw new Error("failed");
          },
        },
        recordUsage: async () => {
          throw new Error("Unknown tokens must not become a zero usage row");
        },
      });
      if (result === "complete")
        assert.equal(
          await model.complete("prompt", { signal: controller.signal }),
          "partial",
        );
      else
        await assert.rejects(() =>
          model.complete("prompt", { signal: controller.signal }),
        );
      const rows = await db.query(
        "SELECT id,user_id,status,prompt_tokens,completion_tokens,total_tokens,token_measurement,provider_cost_usd,finished_at FROM memory_registry.model_invocations",
      );
      assert.equal(rows.rows.length, 1);
      const receipt = rows.rows[0]!;
      assert.match(String(receipt.id), /^[a-f0-9-]{36}$/);
      assert.equal(receipt.user_id, "actor");
      assert.equal(receipt.status, result === "complete" ? "ready" : result);
      for (const field of [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "token_measurement",
        "provider_cost_usd",
      ])
        assert.equal(receipt[field], null);
      assert.ok(receipt.finished_at);
    } finally {
      await db.close();
    }
  });
test("measured attempts persist receipts and usage with one shared id even when output fails or is later discarded", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    await db.query(
      "CREATE TABLE usage_fixture(id text PRIMARY KEY,prompt_tokens integer,total_tokens integer)",
    );
    const model = createRecordedMemoryModel({
      database: db,
      userId: "actor",
      sessionId: "s",
      model: "m",
      apiKeyTier: "byok",
      provider: {
        async *generateStream() {
          yield {
            type: "text",
            content: "partial",
            usage: {
              promptTokens: 4,
              completionTokens: 2,
              totalTokens: 6,
              providerCostUsd: 0.01,
            },
          } as StreamChunk;
          throw new Error("after billed output");
        },
      },
      recordUsage: async (row) => {
        await db.query("INSERT INTO usage_fixture VALUES($1,$2,$3)", [
          row.id,
          row.promptTokens,
          row.totalTokens,
        ]);
      },
    });
    await assert.rejects(() => model.complete("prompt"));
    await assert.rejects(() => model.complete("retry"));
    const receipts = await db.query(
        "SELECT * FROM memory_registry.model_invocations ORDER BY id",
      ),
      logs = await db.query("SELECT * FROM usage_fixture ORDER BY id");
    assert.equal(receipts.rows.length, 2);
    assert.notEqual(receipts.rows[0]!.id, receipts.rows[1]!.id);
    assert.deepEqual(
      logs.rows.map((r) => r.id),
      receipts.rows.map((r) => r.id),
    );
    for (const receipt of receipts.rows) {
      assert.equal(Number(receipt.prompt_tokens), 4);
      assert.equal(Number(receipt.total_tokens), 6);
      assert.equal(receipt.token_measurement, "provider");
      assert.equal(Number(receipt.provider_cost_usd), 0.01);
      assert.equal(receipt.status, "failed");
    }
  } finally {
    await db.close();
  }
});
