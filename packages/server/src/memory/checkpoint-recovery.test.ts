import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { user, apiKeys, creditWallets } from "../db/schema.js";
import { env } from "../lib/env.js";
import { encryptApiKey } from "../lib/crypto.js";
import { getMemoryRuntime, closeMemoryRuntime } from "./runtime.js";
import { ensureProfileSchema, quoteSchema } from "./schema.js";
import { createStoryhavenController } from "./commands.js";
import {
  startMemoryWorker,
  stopMemoryWorker,
  drainMemoryWork,
} from "./yumina-adapter.js";

function sse(content: string) {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("accepted fact checkpoint survives interrupted clustering and persisted runtime restart without repeating model attempts", async (t) => {
  await stopMemoryWorker();
  await closeMemoryRuntime();
  await ensureStoryhavenMemoryTables();
  const dataDir = await mkdtemp(
    join(tmpdir(), "storyhaven-checkpoint-recovery-"),
  );
  const previousDir = env.MEMORY_PGLITE_DATA_DIR;
  env.MEMORY_PGLITE_DATA_DIR = dataDir;
  let extracted = 0,
    reconciled = 0,
    clustered = 0;
  let clusterStarted!: () => void;
  const waitingForCluster = new Promise<void>((resolve) => {
    clusterStarted = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith("/embeddings"))
        return Response.json({ data: [{ embedding: [1, 0, 0] }] });
      assert.ok(
        url.endsWith("/chat/completions"),
        "only deterministic provider fixture routes execute",
      );
      const prompt = String(body.messages?.at(-1)?.content ?? "");
      if (prompt.startsWith("Analyze this roleplay")) {
        extracted++;
        return sse(
          JSON.stringify({
            facts: Array.from({ length: 8 }, (_, i) => ({
              text: `Accepted scene event ${i}.`,
              fact_type: "event",
              participants: ["Mira"],
              importance: 3,
              valence: 0,
            })),
            char_state: {
              doing: "watching the gate",
              location: "Gate",
              npcs: [],
            },
          }),
        );
      }
      if (prompt.startsWith("You maintain a story's memory database")) {
        reconciled++;
        return sse(
          JSON.stringify(
            Array.from({ length: 8 }, (_, index) => ({ index, action: "add" })),
          ),
        );
      }
      assert.ok(
        prompt.startsWith("Summarize the following story facts") ||
          prompt.startsWith("Here is the story so far"),
      );
      clustered++;
      clusterStarted();
      // A stopped/crashed worker cannot accept the prepared cluster. The source
      // model fallback is tolerated, then the cancellation fence rejects commit.
      await new Promise<void>((_, reject) => {
        const aborted = () =>
          reject(
            new DOMException("Fixture clustering cancelled", "AbortError"),
          );
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener("abort", aborted, { once: true });
      });
      throw new Error("Unreachable cluster response");
    },
  );
  try {
    const key = encryptApiKey("checkpoint-fixture-key");
    await db.insert(user).values({
      id: "checkpoint-owner",
      name: "Player",
      email: "checkpoint@fixture.invalid",
      preferences: {
        preferredProvider: "private",
        activeApiKeyId: "checkpoint-key",
      },
    });
    await db.insert(apiKeys).values({
      id: "checkpoint-key",
      userId: "checkpoint-owner",
      provider: "custom",
      baseUrl: "https://checkpoint.fixture.invalid/v1",
      encryptedKey: key.encrypted,
      keyIv: key.iv,
      keyTag: key.tag,
      metadata: { models: ["checkpoint-fixture"] },
    });
    await db.insert(creditWallets).values({
      userId: "checkpoint-owner",
      plan: "internal",
      balance: 100,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 86400000),
    });
    await db.execute(
      sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('checkpoint-world','checkpoint-owner','Mira','{"name":"Mira","entries":[],"variables":[]}')`,
    );
    await db.execute(
      sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('checkpoint-session','checkpoint-owner','checkpoint-world')`,
    );
    const first = await getMemoryRuntime();
    const profile = await first.profiles.create("checkpoint-owner", {
      baseUrl: "https://embedding.fixture.invalid/v1",
      model: "checkpoint-space",
      dimensions: 3,
      apiKey: "checkpoint-embedding",
    });
    await ensureProfileSchema(first.database, profile);
    await first.profiles.setStatus("checkpoint-owner", profile.id, "ready");
    await first.profiles.activate(
      "checkpoint-owner",
      profile.id,
      profile.revision,
    );
    const controller = (await createStoryhavenController(
      "checkpoint-owner",
      "checkpoint-session",
    ))!;
    await controller.mutate("settings", {
      backend: "storyhaven",
      settings: { model: "custom/checkpoint-fixture" },
    });
    for (let i = 0; i < 12; i++)
      await db.execute(
        sql`INSERT INTO messages(id,session_id,role,content,created_at) VALUES(${`checkpoint-${i}`},'checkpoint-session',${i % 2 ? "assistant" : "user"},${i % 2 ? `Mira answers in scene ${i}.` : `Player acts in scene ${i}.`},${new Date(2020, 0, 1, 0, 0, i)})`,
      );
    startMemoryWorker();
    const draining = drainMemoryWork();
    await waitingForCluster;
    await stopMemoryWorker();
    await draining;
    const schema = quoteSchema(profile.schemaName);
    const before = (
      await first.database.query(
        `SELECT id,text,batch_id FROM ${schema}.memory_facts WHERE session_id=$1 ORDER BY id`,
        ["checkpoint-session"],
      )
    ).rows;
    assert.equal(before.length, 8);
    assert.equal(
      (
        await first.database.query(
          `SELECT settled_exchanges FROM ${schema}.memory_extract_cursors WHERE session_id=$1`,
          ["checkpoint-session"],
        )
      ).rows[0]?.settled_exchanges,
      5,
    );
    assert.equal(
      (
        await first.database.query(
          `SELECT count(*) AS n FROM ${schema}.memory_clusters WHERE session_id=$1`,
          ["checkpoint-session"],
        )
      ).rows[0]?.n,
      0,
    );
    assert.deepEqual([extracted, reconciled, clustered], [1, 1, 1]);
    assert.deepEqual(
      (
        await first.database.query(
          "SELECT pair_count FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
          [profile.id, "checkpoint-session"],
        )
      ).rows,
      [{ pair_count: 5 }],
      "accepted facts and their restart checkpoint commit atomically before clustering",
    );
    await closeMemoryRuntime();

    // Reload the actual durable memory store, rather than constructing a fresh
    // repository over an already-open database or recreating accepted fixtures.
    const restarted = await getMemoryRuntime();
    assert.equal(
      (await restarted.profiles.getActive("checkpoint-owner"))!.id,
      profile.id,
    );
    await (await createStoryhavenController(
      "checkpoint-owner",
      "checkpoint-session",
    ))!.mutate("retry", {});
    startMemoryWorker();
    await drainMemoryWork();
    await stopMemoryWorker();
    const after = (
      await restarted.database.query(
        `SELECT id,text,batch_id FROM ${schema}.memory_facts WHERE session_id=$1 ORDER BY id`,
        ["checkpoint-session"],
      )
    ).rows;
    assert.deepEqual(
      after,
      before,
      "accepted fact and batch identities survive checkpoint restore",
    );
    assert.equal(
      (
        await restarted.database.query(
          `SELECT settled_exchanges FROM ${schema}.memory_extract_cursors WHERE session_id=$1`,
          ["checkpoint-session"],
        )
      ).rows[0]?.settled_exchanges,
      5,
    );
    assert.deepEqual(
      [extracted, reconciled, clustered],
      [1, 1, 1],
      "source cursor resumption does not repeat extraction, reconciliation, or clustering",
    );
    assert.equal(
      (
        await db.execute(
          sql`SELECT status FROM storyhaven_memory_sessions WHERE session_id='checkpoint-session'`,
        )
      ).rows[0]?.status,
      "ready",
    );
    const receipts = (
      await restarted.database.query(
        "SELECT status FROM memory_registry.model_invocations WHERE user_id=$1",
        ["checkpoint-owner"],
      )
    ).rows;
    assert.equal(receipts.length, 3);
    assert.equal(
      receipts.filter((row) => row.status === "cancelled").length,
      1,
    );
  } finally {
    await stopMemoryWorker();
    await closeMemoryRuntime();
    env.MEMORY_PGLITE_DATA_DIR = previousDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
