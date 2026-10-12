import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { createMemoryRepositories } from "./repositories/index.js";
import {
  reconcileAuthoredLore,
  visibleLoreRepositories,
  type AuthoredLoreEntry,
} from "./authored-lore.js";
import { createLoreService } from "./lore.js";
async function fixture() {
  const database = await createMemoryDatabase();
  await ensureRegistry(database);
  const profiles = new ProfileRepository(database, {
    encrypt: (s) => s,
    decrypt: (s) => s,
  });
  const profile = await profiles.create("owner", {
    baseUrl: "http://localhost",
    model: "test",
    dimensions: 3,
  });
  await ensureProfileSchema(database, profile);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: "owner",
    sessionId: "session",
    charId: "world",
  };
  await ensureIdentity(database, scope);
  return {
    database,
    profile,
    scope,
    repositories: createMemoryRepositories(database, scope, new Uint8Array(32)),
  };
}
const embedding = {
  embed: async () => [1, 0, 0],
  embedQuery: async () => [1, 0, 0],
};
const model = { complete: async () => "1. Generated secret." };
test("hidden semantic first hit cannot consume visible top-k or leak through links", async () => {
  const f = await fixture();
  try {
    const r = f.repositories;
    await r.lore.upsert({
      id: "world:hidden",
      name: "Spoiler name",
      content: "Spoiler full text",
      hidden: true,
    });
    await r.lore.upsert({
      id: "world:visible",
      name: "Visible",
      content: "Visible text",
    });
    await r.vectors.storeLoreVector("world:hidden", [1, 0, 0]);
    await r.vectors.storeLoreVector("world:visible", [0, 1, 0]);
    await r.lore.addLink("world:visible", "world:hidden", "reveals");
    const visible = visibleLoreRepositories(r);
    assert.equal(
      (await visible.vectors.searchLoreChunks([1, 0, 0], 1, 2))[0]?.lore_id,
      "world:visible",
    );
    assert.equal(await visible.lore.get("world:hidden"), null);
    assert.deepEqual(await visible.lore.chunksFor("world:hidden"), []);
    const service = createLoreService({
      repositories: visible,
      embedding,
      model,
      charId: "world",
    });
    const candidates = await service.fetchCandidates(
      [(await r.lore.get("world:visible"))!],
      [1, 0, 0],
      {},
      1,
    );
    assert.ok(!JSON.stringify(candidates).includes("Spoiler"));
  } finally {
    await f.database.close();
  }
});
test("authored secret-only, keyword, always and link edits persist, stable secrets avoid regeneration", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const deps = {
      repositories: f.repositories,
      embedding,
      model: {
        complete: async () => {
          calls++;
          return "1. Generated secret.";
        },
      },
      worldId: "world",
    };
    const entries: AuthoredLoreEntry[] = [
      {
        id: "world:a",
        name: "A",
        content: "A",
        hidden: true,
        secrets: ["First"],
        keys: ["old"],
        links: [{ targetId: "b", label: "old" }],
      },
      { id: "world:b", name: "B", content: "B" },
    ];
    await reconcileAuthoredLore({ ...deps, entries });
    const first = (await f.repositories.lore.secretsFor("world:a"))[0]!;
    await reconcileAuthoredLore({ ...deps, entries });
    assert.equal(
      (await f.repositories.lore.secretsFor("world:a"))[0]!.id,
      first.id,
    );
    assert.equal(calls, 0);
    entries[0] = {
      ...entries[0]!,
      secrets: ["Second"],
      keys: ["new"],
      always: true,
      links: [],
    } as (typeof entries)[0];
    await reconcileAuthoredLore({ ...deps, entries });
    assert.equal(
      (await f.repositories.lore.secretsFor("world:a"))[0]!.text,
      "Second",
    );
    assert.deepEqual((await f.repositories.lore.get("world:a"))!.keys, ["new"]);
    assert.equal((await f.repositories.lore.get("world:a"))!.always, true);
    assert.deepEqual(await f.repositories.lore.linksFor(["world:a"]), []);
    assert.equal(
      (await f.repositories.vectors.searchSecretIds([1, 0, 0], 4, 1)).length,
      1,
    );
  } finally {
    await f.database.close();
  }
});
test("disabled/deleted authored lore removes reveals, linked facts and summaries; hidden auto secrets index", async () => {
  const f = await fixture();
  try {
    const r = f.repositories;
    const deps = { repositories: r, embedding, model, worldId: "world" };
    await reconcileAuthoredLore({
      ...deps,
      entries: [
        { id: "world:a", name: "A", content: "Hidden", hidden: true },
        { id: "world:b", name: "B", content: "B" },
      ],
    });
    const secret = (await r.lore.secretsFor("world:a"))[0]!;
    assert.equal(secret.text, "Generated secret.");
    const fact = await r.facts.insert(
      {
        text: secret.text,
        fact_type: "world",
        participants: [],
        importance: 3,
        valence: 0,
        turn: 1,
      },
      [1, 0, 0],
    );
    await r.lore.reveal(secret.id, null, fact);
    await r.clusters.insert("Quoted secret", 1, [], "", [1, 0, 0]);
    await reconcileAuthoredLore({
      ...deps,
      entries: [
        {
          id: "world:a",
          name: "A",
          content: "Hidden",
          hidden: true,
          enabled: false,
        },
      ],
    });
    assert.equal(await r.lore.get("world:a"), null);
    assert.equal(await r.lore.get("world:b"), null);
    assert.equal(await r.facts.get(fact), null);
    assert.equal((await r.clusters.activeForSession()).length, 0);
  } finally {
    await f.database.close();
  }
});

test("provider preparation stays outside transactions and rejected fence cannot alter authored rows", async () => {
  const f = await fixture();
  try {
    let inTransaction = false;
    const guarded = {
      query: f.database.query.bind(f.database),
      close: async () => {},
      transaction: async <T>(
        work: (db: import("./types.js").MemoryDatabase) => Promise<T>,
      ): Promise<T> =>
        f.database.transaction(async (tx) => {
          inTransaction = true;
          const protect = (
            database: import("./types.js").MemoryDatabase,
          ): import("./types.js").MemoryDatabase => ({
            query: async <R extends Record<string, unknown>>(
              query: string,
              values?: unknown[],
            ) => {
              if (/^(INSERT|DELETE|UPDATE)/i.test(query.trim()))
                throw new Error("fence rejected");
              return database.query<R>(query, values);
            },
            close: async () => {},
            transaction: (work) =>
              database.transaction((nested) => work(protect(nested))),
          });
          const fence = {
            ...tx,
            close: async () => {},
            transaction: tx.transaction.bind(tx),
            query: async <R extends Record<string, unknown>>(
              query: string,
              values?: unknown[],
            ) => {
              if (/^(INSERT|DELETE|UPDATE)/i.test(query.trim()))
                throw new Error("fence rejected");
              return tx.query<R>(query, values);
            },
          };
          try {
            return await work(protect(fence));
          } finally {
            inTransaction = false;
          }
        }),
    };
    const repositories = createMemoryRepositories(
      guarded,
      f.scope,
      new Uint8Array(32),
    );
    await assert.rejects(
      reconcileAuthoredLore({
        repositories,
        worldId: "world",
        entries: [
          { id: "world:new", name: "New", content: "New", hidden: true },
        ],
        model: {
          complete: async () => {
            assert.equal(inTransaction, false);
            return "1. New secret.";
          },
        },
        embedding: {
          ...embedding,
          embed: async () => {
            assert.equal(inTransaction, false);
            return [1, 0, 0];
          },
        },
      }),
      /fence rejected/,
    );
    assert.equal(await f.repositories.lore.get("world:new"), null);
  } finally {
    await f.database.close();
  }
});
