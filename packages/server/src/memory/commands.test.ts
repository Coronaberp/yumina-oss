import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import {
  createStoryhavenController,
  markMemoryAccountEnabled,
} from "./commands.js";
import { getMemoryRuntime, closeMemoryRuntime } from "./runtime.js";
import { ensureIdentity, ensureProfileSchema } from "./schema.js";
import { createMemoryRepositories } from "./repositories/index.js";
import { saveSessionSnapshot } from "./snapshots.js";
import { decryptMemoryText, encryptMemoryText } from "./crypto.js";
import {
  loadStoryhavenTurnContext,
  retrieveStoryhavenMemory,
  scopeFor,
  settledPairs,
  drainMemoryWork,
  stopMemoryWorker,
} from "./yumina-adapter.js";

test("real controls preserve source snapshots, redact hidden lore, forget durably, clear the settled frontier and purge a deleted owner", async () => {
  await stopMemoryWorker();
  await ensureTables();
  const r = await getMemoryRuntime();
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
      headers: { "Content-Type": "application/json" },
    });
  try {
    await db.execute(
      sql`INSERT INTO "user"(id,name,email) VALUES('controls-u','Player','controls@example.test')`,
    );
    await db.execute(
      sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('controls-w','controls-u','Mira','{"name":"Mira","entries":[{"id":"hidden","name":"Spoiler title","role":"lore","content":"Forbidden full secret","enabled":true,"memory":{"hidden":true}}],"variables":[]}')`,
    );
    await db.execute(
      sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('controls-s','controls-u','controls-w')`,
    );
    const profile = await r.profiles.create("controls-u", {
      baseUrl: "http://127.0.0.1:8099",
      model: "source-test",
      dimensions: 3,
      sendDimensions: false,
      apiKey: "secret",
    });
    await ensureProfileSchema(r.database, profile);
    await r.profiles.setStatus("controls-u", profile.id, "ready");
    await r.profiles.activate("controls-u", profile.id, profile.revision);
    await markMemoryAccountEnabled("controls-u");
    assert.equal(
      await createStoryhavenController("foreign", "controls-s"),
      null,
    );
    const controller = (await createStoryhavenController(
      "controls-u",
      "controls-s",
    ))!;
    await controller.mutate("settings", { backend: "storyhaven" });
    await controller.mutate("settings", {
      settings: { model: "explicit-model" },
    });
    await controller.mutate("settings", {
      settings: { model: null, memoryBudgetTokens: 1200 },
    });
    await db.execute(sql`UPDATE "user" SET preferences='{"aiConfig":{"memoryBudgetTokens":4096}}'::jsonb WHERE id='controls-u'`);
    const override = await controller.status() as { settings: { memoryBudgetTokens: number }; memoryBudgetTokensInherited: boolean };
    assert.equal(override.settings.memoryBudgetTokens, 1200);
    assert.equal(override.memoryBudgetTokensInherited, false);
    const inherited = await controller.mutate("settings", { settings: { memoryBudgetTokens: null } }) as typeof override;
    assert.equal(inherited.settings.memoryBudgetTokens, 4096);
    assert.equal(inherited.memoryBudgetTokensInherited, true);
    const inheritedContext = await loadStoryhavenTurnContext({ ownerUserId: "controls-u", actingUserId: "controls-u", sessionId: "controls-s" });
    assert.equal(inheritedContext.settings.memoryBudgetTokens, undefined);
    await controller.mutate("settings", { settings: { memoryBudgetTokens: 1200 } });
    const defaults = await loadStoryhavenTurnContext({
      ownerUserId: "controls-u",
      actingUserId: "controls-u",
      sessionId: "controls-s",
      model: "current-story-model",
    });
    assert.equal(defaults.model, "current-story-model");
    assert.equal(defaults.settings.model, undefined);
    assert.equal(defaults.settings.memoryBudgetTokens, 1200);
    for (let i = 0; i < 12; i++)
      await db.execute(
        sql`INSERT INTO messages(id,session_id,role,content,created_at) VALUES(${`controls-${i}`},'controls-s',${i % 2 ? "assistant" : "user"},${i % 2 ? "Mira replies." : "Continue the story."},${new Date(2020, 0, 1, 0, 0, i)})`,
      );
    const ctx = await loadStoryhavenTurnContext({
      ownerUserId: "controls-u",
      actingUserId: "controls-u",
      sessionId: "controls-s",
    });
    assert.equal(settledPairs(ctx), 5);
    await ensureIdentity(r.database, scopeFor(profile, ctx));
    const repos = createMemoryRepositories(
      r.database,
      scopeFor(profile, ctx),
      r.key,
    );
    const id = await repos.facts.insert(
      {
        text: "Mira holds a brass key.",
        fact_type: "inventory",
        participants: ["Mira"],
        importance: 4,
        valence: 0,
        turn: 2,
      },
      [1, 0, 0],
    );
    await repos.facts.setCursor(5);
    await repos.lore.upsert({
      id: "controls-w:hidden",
      name: "Spoiler title",
      content: "Forbidden full secret",
      hidden: true,
    });
    await repos.lore.setSecrets("controls-w:hidden", [
      "A visible detail.",
      "Unrevealed detail.",
    ]);
    const secrets = await repos.lore.secretsFor("controls-w:hidden");
    await repos.lore.reveal(secrets[0]!.id, null, id);
    await saveSessionSnapshot(
      r.database,
      profile,
      "controls-s",
      5,
      ctx.messages,
      r.key,
      { worldHash: ctx.worldHash, group: false },
    );
    let status = (await controller.status()) as {
      facts: Array<{ id: string; text: string; pinned: boolean }>;
      lore: unknown[];
    };
    assert.equal(status.facts.length, 1);
    assert.ok(!JSON.stringify(status).includes('secret"'));
    assert.ok(!JSON.stringify(status).includes("Forbidden full secret"));
    assert.ok(!JSON.stringify(status).includes("Spoiler title"));
    assert.ok(!JSON.stringify(status).includes("Unrevealed detail"));
    assert.ok(JSON.stringify(status).includes("A visible detail."));
    await controller.mutate("fact", {
      id,
      pinned: true,
      text: "Mira keeps the brass key.",
    });
    status = (await controller.status()) as typeof status;
    assert.equal(status.facts[0]!.pinned, true);
    assert.equal(status.facts[0]!.text, "Mira keeps the brass key.");
    const recall = await retrieveStoryhavenMemory({
      ownerUserId: "controls-u",
      actingUserId: "controls-u",
      sessionId: "controls-s",
      query: "key",
    });
    assert.ok(recall.result.block.includes("brass key"));
    assert.ok(recall.result.usedIds.includes(id));
    const stored = (
      await r.database.query(
        "SELECT payload FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2 AND pair_count=5",
        [profile.id, "controls-s"],
      )
    ).rows[0]!;
    const frozen = JSON.parse(decryptMemoryText(String(stored.payload), r.key));
    frozen.data.memory_facts.push({
      ...frozen.data.memory_facts[0],
      id: "checkpoint-predecessor",
      text: encryptMemoryText("Mira used to carry a silver key.", r.key),
      superseded_by: id,
      valid_from_turn: 0,
      valid_until_turn: 1,
    });
    await r.database.query(
      "UPDATE memory_snapshots SET payload=$1 WHERE profile_id=$2 AND session_id=$3 AND pair_count=5",
      [
        encryptMemoryText(JSON.stringify(frozen), r.key),
        profile.id,
        "controls-s",
      ],
    );
    assert.equal(await repos.facts.get("checkpoint-predecessor"), null);
    assert.equal(
      ((await controller.mutate("lineage", { id })) as Array<{ id: string }>)[0]
        ?.id,
      "checkpoint-predecessor",
    );
    await r.database.query(
      "UPDATE memory_snapshots SET payload=$1 WHERE profile_id=$2 AND session_id=$3 AND pair_count=5",
      [stored.payload, profile.id, "controls-s"],
    );
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      entered();
      await paused;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
    };
    const staleKeyEdit = controller.mutate("fact", {
      id,
      text: "Must reject old credential output.",
    });
    await reached;
    await r.profiles.updateKey("controls-u", profile.id, "rotated-secret");
    release();
    await assert.rejects(staleKeyEdit);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
    assert.equal(
      ((await controller.status()) as typeof status).facts[0]!.text,
      "Mira keeps the brass key.",
    );
    await controller.mutate("forget", { id });
    assert.equal(
      ((await controller.status()) as typeof status).facts.length,
      0,
    );
    assert.equal(
      (await r.database.query("SELECT * FROM memory_forget_ledger")).rows
        .length,
      1,
    );
    await controller.mutate("clear", {});
    const cleared = (await controller.status()) as {
      frontier: number;
      facts: unknown[];
    };
    assert.equal(cleared.frontier, 5);
    assert.equal(cleared.facts.length, 0);
    await controller.mutate("rebuild", {});
    assert.equal(
      ((await controller.status()) as { frontier: number }).frontier,
      0,
    );
    await db.execute(
      sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('controls-deleted','controls-u','controls-w')`,
    );
    await db.execute(
      sql`INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload,delivered_at) VALUES('controls-u','controls-deleted','fork',0,'{"encryptedPayload":"residual encrypted checkpoint"}',NOW())`,
    );
    await db.execute(
      sql`DELETE FROM play_sessions WHERE id='controls-deleted'`,
    );
    await drainMemoryWork();
    assert.equal(
      (
        await db.execute(
          sql`SELECT id FROM storyhaven_memory_outbox WHERE session_id='controls-deleted'`,
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.execute(
          sql`SELECT id FROM play_sessions WHERE id='controls-s'`,
        )
      ).rows.length,
      1,
    );
    await db.execute(
      sql`INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload,delivered_at) VALUES('controls-u','controls-s','fork',0,'{"encryptedPayload":"residual encrypted checkpoint"}',NOW())`,
    );
    await db.execute(sql`DELETE FROM "user" WHERE id='controls-u'`);
    await drainMemoryWork();
    assert.equal((await r.profiles.list("controls-u")).length, 0);
    assert.equal(
      (
        await db.execute(
          sql`SELECT id FROM storyhaven_memory_outbox WHERE owner_user_id='controls-u'`,
        )
      ).rows.length,
      0,
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    await stopMemoryWorker();
    await closeMemoryRuntime();
  }
});
