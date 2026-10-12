import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono, type MiddlewareHandler } from "hono";
import { eq, sql } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import {
  user,
  worlds,
  playSessions,
  apiKeys,
  creditWallets,
  messages,
} from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import type { AppEnv } from "../lib/types.js";
import { messageRoutes } from "../routes/messages.js";
import { createMemoryProfileRoutes } from "../routes/memory-profiles.js";
import { createStoryhavenMemoryRoutes } from "../routes/storyhaven-memory.js";
import {
  createStoryhavenController,
  markMemoryAccountEnabled,
} from "./commands.js";
import {
  getMemoryRuntime,
  closeMemoryRuntime,
  activateMemoryProfile,
  testMemoryProfile,
} from "./runtime.js";
import { ensureProfileSchema, quoteSchema } from "./schema.js";
import {
  startMemoryWorker,
  stopMemoryWorker,
  drainMemoryWork,
} from "./yumina-adapter.js";

type RecordedRequest = {
  url: string;
  body: Record<string, any>;
  authorization: string | null;
};
function completionResponse(content: string, stream: unknown): Response {
  const usage = { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 };
  if (!stream)
    return Response.json({
      id: "fixture-response",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage,
    });
  return new Response(
    [
      `data: ${JSON.stringify({ id: "fixture-response", choices: [{ index: 0, delta: { content } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "fixture-response", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
for (const dimensions of [1024, 3072])
  test(`normal BYOK chat routes inject accepted worker memory at ${dimensions} dimensions`, async (t) => {
    await stopMemoryWorker();
    await ensureStoryhavenMemoryTables();
    const runtime = await getMemoryRuntime();
    const owner = `runtime-${dimensions}`,
      worldId = `world-${dimensions}`,
      model = "custom/runtime-fixture";
    const requests: RecordedRequest[] = [];
    let chatCalls = 0,
      extractCalls = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const headers = new Headers(init?.headers);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        requests.push({
          url,
          body,
          authorization: headers.get("authorization"),
        });
        if (url.endsWith("/embeddings")) {
          assert.equal(
            headers.get("authorization"),
            "Bearer fixture-embedding-key",
          );
          return Response.json({
            data: [
              {
                index: 0,
                embedding: Array.from(
                  { length: Number(body.dimensions ?? dimensions) },
                  (_, i) => (i === 0 ? 1 : 0),
                ),
              },
            ],
          });
        }
        if (url.endsWith("/chat/completions")) {
          assert.equal(headers.get("authorization"), "Bearer fixture-chat-key");
          const prompt = String(body.messages?.at(-1)?.content ?? "");
          let content: string;
          if (prompt.startsWith("Analyze this roleplay")) {
            extractCalls++;
            content = JSON.stringify({
              facts: [
                {
                  text:
                    extractCalls === 1
                      ? "The gate remains closed."
                      : "The gate is open.",
                  fact_type: "state",
                  participants: [],
                  importance: 4,
                  valence: 0,
                },
                ...(extractCalls > 1
                  ? [
                      {
                        text: "Mira found the key under the stone.",
                        fact_type: "event",
                        participants: ["Mira"],
                        importance: 4,
                        valence: 1,
                      },
                    ]
                  : []),
              ],
              char_state: {
                doing: "watching the gate",
                location: "Gate",
                npcs: [],
              },
            });
          } else if (
            prompt.startsWith("You maintain a story's memory database")
          ) {
            const previous = prompt.match(
              /\[id=([^\]]+)\] The gate remains closed\./,
            )?.[1];
            content = JSON.stringify([
              {
                index: 0,
                action: previous ? "supersede" : "add",
                ...(previous ? { target_id: previous } : {}),
              },
              ...(extractCalls > 1 ? [{ index: 1, action: "add" }] : []),
            ]);
          } else if (
            prompt.startsWith("You maintain a story's world lorebook")
          ) {
            const gate = prompt.match(/\[lore_id=([^\]]+:gate)\]/)?.[1];
            content =
              extractCalls > 1 && gate
                ? JSON.stringify([
                    {
                      index: 0,
                      lore_id: gate,
                      new_content: "The city gate stands open.",
                    },
                  ])
                : "[]";
          } else if (
            prompt.startsWith("You maintain a story's hidden lore secrets")
          ) {
            const secret = prompt.match(
              /\[secret_id=([^\]]+)\] The key lies under the stone\./,
            )?.[1];
            content =
              extractCalls > 1 && secret
                ? JSON.stringify([{ index: 1, secret_id: secret }])
                : "[]";
          } else if (prompt.startsWith("You decompose hidden lore"))
            content =
              "1. The key lies under the stone.\n2. Mira is the rightful queen.";
          else {
            chatCalls++;
            content = `Mira watches the gate, scene ${chatCalls}.`;
          }
          return completionResponse(content, body.stream);
        }
        if (url.endsWith("/models"))
          return Response.json({
            data: [
              {
                id: "runtime-fixture",
                context_length: 32768,
                architecture: { input_modalities: ["text"] },
              },
            ],
          });
        throw new Error(
          `Unexpected fixture HTTP route: ${new URL(url).pathname}`,
        );
      },
    );
    try {
      const encrypted = encryptApiKey("fixture-chat-key");
      await db.insert(user).values({
        id: owner,
        name: "Player",
        email: `${owner}@fixture.invalid`,
        preferences: {
          preferredProvider: "private",
          activeApiKeyId: `key-${dimensions}`,
        },
      });
      await db.insert(apiKeys).values({
        id: `key-${dimensions}`,
        userId: owner,
        provider: "custom",
        baseUrl: "https://chat.fixture.invalid/v1",
        encryptedKey: encrypted.encrypted,
        keyIv: encrypted.iv,
        keyTag: encrypted.tag,
        metadata: { models: ["runtime-fixture"] },
      });
      await db.insert(creditWallets).values({
        userId: owner,
        plan: "internal",
        balance: 100,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86400000),
      });
      const world = migrateWorldDefinition({
        id: worldId,
        version: "19.0.0",
        name: "Mira",
        description: "",
        author: "fixture",
        entries: [
          {
            id: "gate",
            name: "Gate",
            role: "lore",
            section: "system-presets",
            content: "The city gate is closed.",
            keywords: [],
            alwaysSend: true,
            enabled: true,
          },
          {
            id: "hidden",
            name: "Hidden genealogy",
            role: "lore",
            section: "system-presets",
            content:
              "UNREVEALED_ROYAL_LINEAGE: Mira is the rightful queen; the key lies under the stone.",
            keywords: [],
            alwaysSend: true,
            enabled: true,
            memory: {
              hidden: true,
              secrets: [
                "The key lies under the stone.",
                "Mira is the rightful queen.",
              ],
            },
          },
        ],
        variables: [],
        rules: [],
        reactions: [],
        components: [],
        audioTracks: [],
        customUI: [],
        settings: { maxTokens: 1000, temperature: 1, playerName: "Player" },
      } as unknown as WorldDefinition);
      await db.insert(worlds).values({
        id: worldId,
        creatorId: owner,
        name: world.name,
        schema: world as unknown as Record<string, unknown>,
        status: "draft",
      });
      const [session] = await db
        .insert(playSessions)
        .values({ userId: owner, worldId })
        .returning();
      const sid = session!.id;
      let actingOwner = owner;
      const authentication: MiddlewareHandler<AppEnv> = async (c, next) => {
        c.set("user", { id: actingOwner } as AppEnv["Variables"]["user"]);
        await next();
      };
      const app = new Hono<AppEnv>();
      app.use("*", authentication);
      app.route(
        "/api/memory/profiles",
        createMemoryProfileRoutes(
          {
            repository: runtime.profiles,
            prepare: (p) => ensureProfileSchema(runtime.database, p),
            test: testMemoryProfile,
            activate: async (p) => {
              await activateMemoryProfile(p);
              await markMemoryAccountEnabled(p.userId);
            },
          },
          authentication,
        ),
      );
      app.route(
        "/api/sessions",
        createStoryhavenMemoryRoutes(
          createStoryhavenController,
          authentication,
        ),
      );
      for (const pattern of [
        "/sessions/:sessionId/messages",
        "/sessions/:sessionId/continue",
        "/messages/:id/regenerate",
        "/messages/:id/swipe",
      ]) {
        for (const route of messageRoutes.routes.filter(
          (r) => r.path === pattern,
        ))
          app.on(route.method, `/api${pattern}`, route.handler);
      }
      const request = (path: string, body: unknown, method = "POST") =>
        app.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const created = await request("/api/memory/profiles", {
        baseUrl: "https://embedding.fixture.invalid/v1",
        model: "fixture-space",
        dimensions,
        sendDimensions: true,
        apiKey: "fixture-embedding-key",
      });
      assert.equal(created.status, 201, await created.clone().text());
      const profileDto = ((await created.json()) as { profile: { id: string } })
        .profile;
      assert.equal(
        (await request(`/api/memory/profiles/${profileDto.id}/activate`, {}))
          .status,
        200,
      );
      assert.equal(
        (
          await db.execute(
            sql`SELECT backend FROM storyhaven_memory_sessions WHERE session_id=${sid}`,
          )
        ).rows[0]?.backend,
        "legacy",
        "activating a profile preserves existing sessions",
      );
      assert.equal(
        (
          await request(
            `/api/sessions/${sid}/memory/storyhaven/settings`,
            {
              backend: "storyhaven",
              settings: { model, clusterTriggerCount: 50 },
            },
            "PATCH",
          )
        ).status,
        200,
      );
      const send = async (content: string, targetSessionId = sid) => {
        const response = await request(
          `/api/sessions/${targetSessionId}/messages`,
          {
            content,
            model,
          },
        );
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.match(text, /event: done/);
        assert.doesNotMatch(text, /event: error/);
        const chunk = text
          .split("\n\n")
          .find((part) => part.includes("event: done\n"))!;
        return JSON.parse(
          chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        ) as { messageId: string };
      };
      const replies: string[] = [];
      for (let i = 0; i < 6; i++)
        replies.push(
          (await send(`We inspect the gate in scene ${i}.`)).messageId,
        );
      startMemoryWorker();
      await drainMemoryWork();
      await stopMemoryWorker();
      const profile = (await runtime.profiles.getActive(owner))!;
      assert.equal(
        extractCalls,
        1,
        "six completed chat exchanges trigger the first settled five-exchange extraction",
      );
      const stored = await runtime.database.query(
        `SELECT text FROM ${quoteSchema(profile.schemaName)}.memory_facts WHERE session_id=$1`,
        [sid],
      );
      assert.equal(stored.rows.length, 1);
      assert.match(
        String(stored.rows[0]!.text),
        /^enc:/,
        "separate memory database stores encrypted facts",
      );
      assert.equal(
        (
          await db.execute(
            sql`SELECT to_regclass('memory_registry.profiles') AS name`,
          )
        ).rows[0]?.name,
        null,
        "profile registry never appears in application database",
      );
      replies.push((await send("What is the gate state now?")).messageId);
      const chatRequests = () =>
        requests.filter(
          (r) =>
            r.url.endsWith("/chat/completions") &&
            !(
              r.body.messages?.length === 1 &&
              String(r.body.messages[0]?.content).startsWith(
                "Analyze this roleplay",
              )
            ) &&
            !String(r.body.messages?.at(-1)?.content).startsWith(
              "You maintain a story's",
            ),
        );
      const seventh = chatRequests().at(-1)!;
      const memoryBlocks = seventh.body.messages.filter(
        (m: { role: string; content: string }) =>
          m.role === "system" && m.content.includes("The gate remains closed."),
      );
      assert.ok(
        memoryBlocks.length,
        "accepted worker memory reaches the real serialized chat request",
      );
      assert.doesNotMatch(
        JSON.stringify(seventh.body.messages),
        /UNREVEALED_ROYAL_LINEAGE|Mira is the rightful queen\.|The key lies under the stone\./,
        "hidden authored lore stays outside normal provider prompts before revelation",
      );
      for (let i = 7; i < 11; i++)
        await send(`We open the gate in scene ${i}.`);
      startMemoryWorker();
      await drainMemoryWork();
      await stopMemoryWorker();
      assert.equal(
        extractCalls,
        2,
        "the worker advances the next settled batch once",
      );
      await send("What is the gate state after opening?");
      const currentBlocks = chatRequests()
        .at(-1)!
        .body.messages.filter(
          (m: { role: string; content: string }) => m.role === "system",
        )
        .map((m: { content: string }) => m.content)
        .join("\n");
      assert.match(currentBlocks, /The gate is open\./);
      assert.match(currentBlocks, /The city gate stands open\./);
      assert.match(currentBlocks, /The key lies under the stone\./);
      assert.doesNotMatch(
        currentBlocks,
        /The city gate is closed\.|UNREVEALED_ROYAL_LINEAGE|Mira is the rightful queen\./,
        "session override and revealed secret control authored lore visibility",
      );
      assert.doesNotMatch(
        currentBlocks.split("## Recalled from earlier")[0]!,
        /The gate remains closed\./,
        "superseded state is absent from ongoing memory",
      );
      assert.match(
        currentBlocks,
        /The gate remains closed\. \(this later changed\)/,
        "source supersession lineage remains available as annotated history",
      );
      for (const [path, body] of [
        [`/api/sessions/${sid}/continue`, { model }],
        [`/api/sessions/${sid}/messages`, { continue: true, model }],
      ] as const) {
        const continuation = await request(path, body);
        const stream = await continuation.text();
        assert.equal(continuation.status, 200, stream);
        assert.match(stream, /event: done/);
        assert.doesNotMatch(stream, /event: error/);
        const blocks = chatRequests()
          .at(-1)!
          .body.messages.filter((m: { role: string }) => m.role === "system")
          .map((m: { content: string }) => m.content)
          .join("\n");
        assert.match(blocks, /The gate is open\./);
        assert.match(blocks, /The city gate stands open\./);
        assert.doesNotMatch(
          blocks,
          /UNREVEALED_ROYAL_LINEAGE|Mira is the rightful queen\./,
        );
      }
      const historical = await request(
        `/api/messages/${replies[6]}/regenerate`,
        { model },
      );
      assert.equal(historical.status, 200, await historical.clone().text());
      assert.match(await historical.text(), /event: done/);
      const historicalBlocks = chatRequests()
        .at(-1)!
        .body.messages.filter((m: { role: string }) => m.role === "system")
        .map((m: { content: string }) => m.content)
        .join("\n");
      assert.match(historicalBlocks, /The gate remains closed\./);
      assert.doesNotMatch(
        historicalBlocks,
        /The gate is open\.|The city gate stands open\.|The key lies under the stone\./,
        "past regeneration never receives future memory, lore overrides, or reveals",
      );
      const originalAnswer = await request(
        `/api/messages/${replies[6]}/swipe`,
        { index: 0 },
      );
      assert.equal(
        originalAnswer.status,
        200,
        await originalAnswer.clone().text(),
      );
      await send("Recall the gate after selecting the original answer.");
      const selectedBlocks = chatRequests()
        .at(-1)!
        .body.messages.filter((m: { role: string }) => m.role === "system")
        .map((m: { content: string }) => m.content)
        .join("\n");
      assert.match(
        selectedBlocks,
        /The gate is open\./,
        "restoring the original selected answer makes its historical snapshot eligible again",
      );
      actingOwner = "foreign-owner";
      assert.equal(
        (await app.request(`/api/sessions/${sid}/memory/storyhaven`)).status,
        404,
      );
      assert.equal(
        (await request(`/api/memory/profiles/${profile.id}/activate`, {}))
          .status,
        404,
      );
      actingOwner = owner;
      const receipts = (
        await runtime.database.query(
          "SELECT id,status,total_tokens FROM memory_registry.model_invocations WHERE user_id=$1",
          [owner],
        )
      ).rows;
      assert.ok(receipts.length >= 4);
      assert.equal(new Set(receipts.map((r) => r.id)).size, receipts.length);
      assert.ok(
        receipts.every(
          (r) => r.status === "ready" && Number(r.total_tokens) === 35,
        ),
      );
      assert.ok(
        requests.some(
          (r) =>
            r.url.endsWith("/embeddings") && r.body.dimensions === dimensions,
        ),
      );
      const saved = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sid));
      assert.ok(saved.filter((m) => m.role === "assistant").length >= 12);
      // Delay the durable worker across a real chat backlog, then exercise its
      // catch-up batches and the application-triggered deletion outbox.
      const [catchupSession] = await db
        .insert(playSessions)
        .values({ userId: owner, worldId })
        .returning();
      const catchupId = catchupSession!.id;
      assert.equal(
        (
          await db.execute(
            sql`SELECT backend FROM storyhaven_memory_sessions WHERE session_id=${catchupId}`,
          )
        ).rows[0]?.backend,
        "storyhaven",
        "new sessions adopt the account profile",
      );
      assert.equal(
        (
          await request(
            `/api/sessions/${catchupId}/memory/storyhaven/settings`,
            { settings: { model, clusterTriggerCount: 50 } },
            "PATCH",
          )
        ).status,
        200,
      );
      for (let i = 0; i < 16; i++)
        await send(`Catch-up gate scene ${i}.`, catchupId);
      const catchupRequests = () =>
        requests.filter((request) => {
          const prompt = String(request.body.messages?.at(-1)?.content ?? "");
          return (
            prompt.startsWith("Analyze this roleplay") &&
            prompt.includes("Catch-up gate scene")
          );
        });
      const extractionBeforeCatchup = catchupRequests().length;
      startMemoryWorker();
      await drainMemoryWork();
      await stopMemoryWorker();
      assert.equal(catchupRequests().length - extractionBeforeCatchup, 3);
      const batches = (
        await runtime.database.query(
          `SELECT pair_start,pair_end FROM ${quoteSchema(profile.schemaName)}.memory_extract_batches WHERE session_id=$1 ORDER BY pair_start`,
          [catchupId],
        )
      ).rows;
      assert.deepEqual(
        batches.map((row) => [Number(row.pair_start), Number(row.pair_end)]),
        [
          [0, 5],
          [5, 10],
          [10, 15],
        ],
        "the real worker catches up with original five-exchange batch boundaries",
      );
      await db.delete(playSessions).where(eq(playSessions.id, catchupId));
      await drainMemoryWork();
      assert.equal(
        Number(
          (
            await runtime.database.query(
              `SELECT count(*) AS n FROM ${quoteSchema(profile.schemaName)}.memory_facts WHERE session_id=$1`,
              [catchupId],
            )
          ).rows[0]?.n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await runtime.database.query(
              "SELECT count(*) AS n FROM memory_snapshots WHERE profile_id=$1 AND session_id=$2",
              [profile.id, catchupId],
            )
          ).rows[0]?.n,
        ),
        0,
      );
      assert.equal(
        (
          await runtime.database.query(
            "SELECT deleted FROM memory_session_epochs WHERE profile_id=$1 AND session_id=$2",
            [profile.id, catchupId],
          )
        ).rows[0]?.deleted,
        true,
      );
      assert.equal(
        (await app.request(`/api/sessions/${catchupId}/memory/storyhaven`))
          .status,
        404,
      );
      if (dimensions === 1024) {
        const migration = await request("/api/memory/profiles", {
          baseUrl: "https://embedding.fixture.invalid/v1",
          model: "fixture-space-3072",
          dimensions: 3072,
          sendDimensions: true,
          apiKey: "fixture-embedding-key",
        });
        assert.equal(migration.status, 201, await migration.clone().text());
        const targetId = (
          (await migration.json()) as { profile: { id: string } }
        ).profile.id;
        const accepted = await request(
          `/api/memory/profiles/${targetId}/reindex`,
          {},
        );
        assert.equal(accepted.status, 200, await accepted.clone().text());
        const target = (await runtime.profiles.getActive(owner))!;
        assert.equal(target.id, targetId);
        assert.equal(target.dimensions, 3072);
        assert.equal(
          (await runtime.profiles.get(owner, profile.id))!.dimensions,
          1024,
        );
        assert.equal(
          (await runtime.profiles.get(owner, profile.id))!.active,
          false,
        );
        const migrated = (
          await runtime.database.query(
            `SELECT vector_dims(embedding) AS dimensions FROM ${quoteSchema(target.schemaName)}.memory_facts WHERE session_id=$1 AND embedding IS NOT NULL`,
            [sid],
          )
        ).rows;
        assert.ok(migrated.length > 0);
        assert.ok(migrated.every((row) => Number(row.dimensions) === 3072));
        await send("Recall the gate after changing the embedding model.");
        const migratedBlocks = chatRequests()
          .at(-1)!
          .body.messages.filter((m: { role: string }) => m.role === "system")
          .map((m: { content: string }) => m.content)
          .join("\n");
        assert.match(migratedBlocks, /The gate is open\./);
        assert.match(migratedBlocks, /The city gate stands open\./);
        assert.doesNotMatch(
          migratedBlocks,
          /UNREVEALED_ROYAL_LINEAGE|Mira is the rightful queen\./,
        );
      }
    } finally {
      await stopMemoryWorker();
      await closeMemoryRuntime();
    }
  });
