import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLoreService,
  loreCandidate,
  buildSecretExtractionPrompt,
  parseSecretExtraction,
} from "./lore.js";
const entry = (id: string, char_id: string | null = "char") => ({
  id,
  char_id,
  name: id,
  content: `content ${id}`,
  metadata: { species: "elf" },
});
test("semantic character candidates carry compact identity until a specific biography is needed", async () => {
  const actor = { ...entry("sera"), category: "character", name: "Sera", content: "Full Name: Seraphine\nAge: 247\nSpecies: Angel\nOccupation: Instructor\n\nOPTIONAL_PERSONALITY_DETAIL" };
  const repositories = { lore: { getAllOverridesForSession: async () => ({}), linksFor: async () => [], byIds: async () => [actor], chunksFor: async () => [{ part_id: 0, content: actor.content }] }, vectors: { searchLoreChunks: async () => [{ lore_id: "sera", part_id: 0, distance: .1 }] } };
  const service = createLoreService({ repositories, charId: "char", includeCharacterIdentity: true, maxSemanticCharacters: 4 } as any);
  const semantic = await service.fetchCandidates([], [1], {}, 1);
  assert.match(semantic.map(e => e.text).join("\n"), /Age: 247/);
  assert.doesNotMatch(semantic.map(e => e.text).join("\n"), /OPTIONAL_PERSONALITY_DETAIL/);
  const named = await service.fetchCandidates([{ ...actor, query_matched: true }], [1], {}, 1);
  assert.match(named.map(e => e.text).join("\n"), /OPTIONAL_PERSONALITY_DETAIL/);
});
test("source lore candidates use chunk ids with metadata/links only on first chunk", async () => {
  const entries = [
    entry("a"),
    entry("b"),
    entry("c"),
    entry("global", null),
    entry("foreign", "other"),
  ];
  const repositories: any = {
    lore: {
      getAllOverridesForSession: async () => ({}),
      chunksFor: async (id: string) =>
        id === "a"
          ? [
              { part_id: 0, content: "first" },
              { part_id: 1, content: "second" },
            ]
          : [],
      linksFor: async (ids: string[]) =>
        [
          { lore_id_a: "a", lore_id_b: "b", label: "friend" },
          { lore_id_a: "c", lore_id_b: "a", label: "parent" },
          { lore_id_a: "a", lore_id_b: "global", label: "" },
          { lore_id_a: "a", lore_id_b: "foreign", label: "" },
        ].filter((x) => ids.includes(x.lore_id_a) || ids.includes(x.lore_id_b)),
      byIds: async (ids: string[]) => entries.filter((x) => ids.includes(x.id)),
    },
    vectors: {
      searchLoreChunks: async () => [
        { lore_id: "b", part_id: 0, distance: 0.2 },
        { lore_id: "b", part_id: 1, distance: 0.1 },
      ],
    },
  };
  const service = createLoreService({
    repositories,
    embedding: {},
    model: {},
    charId: "char",
  } as any);
  const candidates = await service.fetchCandidates(
    [entries[0]!],
    [1],
    {},
    9,
    false,
  );
  assert.deepEqual(
    candidates.map((x: any) => x.id),
    ["a#0", "a#1", "b", "c"],
  );
  assert.deepEqual(candidates[0]!.links, [{ label: "friend", name: "b" }]);
  assert.deepEqual(candidates[1]!.metadata, {});
  assert.equal(candidates[3]!.link_label, "parent");
  assert.ok(
    (await service.fetchCandidates([entries[0]!], null, {}, 9, true)).some(
      (x: any) => x.id === "global",
    ),
  );
});
test("keyword lore cap sorts query matches and importance, demotes excess and preserves overrides", async () => {
  const e = Array.from({ length: 14 }, (_, i) => ({
    ...entry(`e${i}`),
    importance: i === 13 ? 5 : 3,
    query_matched: i === 12,
  }));
  const repos: any = {
    lore: {
      getAllOverridesForSession: async () => ({ e12: "override" }),
      chunksFor: async () => [],
      linksFor: async () => [],
      byIds: async () => [],
    },
  };
  const service = createLoreService({
    repositories: repos,
    charId: "char",
  } as any);
  const c = await service.fetchCandidates(e, null, {}, 1);
  assert.deepEqual(
    c.slice(0, 2).map((x: any) => [x.id, x.text]),
    [
      ["e12", "override"],
      ["e13", "content e13"],
    ],
  );
  assert.equal(c.filter((x: any) => x.pinned).length, 12);
  assert.equal(c[13]!.pinned, false);
  assert.deepEqual(loreCandidate(entry("a"), 3), {
    query_matched: false,
    id: "a",
    source: "lore",
    fact_type: "lore",
    text: "content a",
    participants: [],
    importance: 3,
    valence: 0,
    reinforcements: 0,
    pinned: false,
    valid_until_turn: null,
    last_turn: 3,
    distance: 0,
    link_label: null,
    metadata: {},
    links: [],
  });
});
test("secret extraction reproduces numbered-list parsing without imposing extra normalization", () => {
  assert.deepEqual(
    parseSecretExtraction(
      "```\n1. Likes sweets\n2. - Dislikes cake\n- Owns a key\n3.\n```",
    ),
    ["Likes sweets", "Dislikes cake", "Owns a key"],
  );
  assert.match(buildSecretExtractionPrompt("hidden"), /Input:\nhidden$/);
});
test("manual override updates existing linked fact; new overrides create a pinned state", async () => {
  const writes: any[] = [];
  let existing: any = null;
  const repos: any = {
    facts: {
      insert: async (...x: any[]) => {
        writes.push(["insert", ...x]);
        return "newfact";
      },
      updateText: async (...x: any[]) => writes.push(["update", ...x]),
    },
    lore: {
      getState: async () => existing,
      setOverride: async (...x: any[]) => writes.push(["override", ...x]),
    },
  };
  const service = createLoreService({
    repositories: repos,
    charId: "char",
    embedding: { embed: async () => [1] },
  } as any);
  assert.equal(
    await service.applySessionLoreOverride("lore", "content", "batch"),
    "newfact",
  );
  assert.equal(writes[0][1].fact_type, "state");
  assert.equal(writes[0][3], true);
  assert.equal(writes[0][1].turn, 0);
  existing = { override_fact_id: "prior" };
  await service.applySessionLoreOverride("lore", "changed", "b2");
  assert.deepEqual(writes.slice(2), [
    ["update", "prior", "changed", [1]],
    ["override", "lore", "changed", "prior", "b2"],
  ]);
});
test("secret reveal survives failed memory enrichment and rollback restores overrides/deletes reveals", async () => {
  const calls: any[] = [];
  const repos: any = {
    facts: {
      deleteFact: async (...x: any[]) => calls.push(["delete", ...x]),
      updateText: async (...x: any[]) => calls.push(["update", ...x]),
    },
    lore: {
      reveal: async (...x: any[]) => calls.push(["reveal", ...x]),
      statesForBatches: async () => [
        {
          lore_id: "new",
          override_fact_id: "newfact",
          prior_override_content: null,
        },
        {
          lore_id: "old",
          prior_override_fact_id: "prior",
          prior_override_content: "restored",
        },
      ],
      deleteState: async (...x: any[]) => calls.push(["deleteState", ...x]),
      restorePrior: async (...x: any[]) => calls.push(["restore", ...x]),
      deleteRevealsForBatches: async () => 2,
    },
  };
  const service = createLoreService({
    repositories: repos,
    embedding: {
      embed: async () => {
        throw new Error("offline");
      },
    },
  } as any);
  await service.applySecretReveal("secret", "hidden", "batch");
  assert.deepEqual(calls[0], ["reveal", "secret", "batch", null]);
  assert.deepEqual(await service.rollbackSessionLore(["batch"]), {
    overrides_reverted: 1,
    overrides_restored: 1,
    reveals_deleted: 2,
  });
  assert.deepEqual(calls.slice(1), [
    ["delete", "newfact"],
    ["deleteState", "new"],
    ["restore", "old"],
  ]);
});
test("single-chunk authored lore indexes category/name prefix without creating a chunk row", async () => {
  const calls: any[] = [];
  const repos: any = {
    lore: {
      deleteChunks: async (id: string) => calls.push(["deleteChunks", id]),
      setChunks: async (...args: any[]) => calls.push(["setChunks", ...args]),
    },
    vectors: {
      deleteLoreVector: async (id: string) => calls.push(["deleteVector", id]),
      storeLoreVector: async (...args: any[]) => calls.push(["store", ...args]),
    },
  };
  const service = createLoreService({
    repositories: repos,
    embedding: {
      embed: async (text: string) => {
        calls.push(["embed", text]);
        return [1];
      },
    },
  } as any);
  await service.indexLoreEntry({
    ...entry("a"),
    name: "Mira",
    category: "People",
  });
  assert.deepEqual(calls, [
    ["deleteChunks", "a"],
    ["deleteVector", "a"],
    ["embed", "People, Mira: content a"],
    ["store", "a", [1], 0],
  ]);
});
test("numbered secret parsing matches Python Unicode digit prefixes", () => {
  assert.deepEqual(
    parseSecretExtraction("④. secret\n⁹. another\nⅣ. literal numeral"),
    ["secret", "another", "Ⅳ. literal numeral"],
  );
});
import { createMemoryDatabase } from "./database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { createMemoryRepositories } from "./repositories/index.js";
for (const dimensions of [1024, 3072])
  test(`real scoped lore overrides, secret indexing/reveals/rollback at ${dimensions} dimensions`, async () => {
    const db = await createMemoryDatabase();
    try {
      await ensureRegistry(db);
      const profile = await new ProfileRepository(db, {
        encrypt: (s) => s,
        decrypt: (s) => s,
      }).create("owner", { baseUrl: "http://test", model: "test", dimensions });
      await ensureProfileSchema(db, profile);
      const scope = {
        profileId: profile.id,
        schemaName: profile.schemaName,
        ownerUserId: "owner",
        sessionId: "one",
        charId: "char",
      };
      await ensureIdentity(db, scope);
      const other = { ...scope, sessionId: "two" };
      await ensureIdentity(db, other);
      const repos = createMemoryRepositories(db, scope, Buffer.alloc(32, 1)),
        second = createMemoryRepositories(db, other, Buffer.alloc(32, 1));
      const authored = await repos.lore.upsert({
        id: "authored",
        name: "Mira",
        content: "original",
        metadata: { species: "elf" },
      });
      let modelCalls = 0;
      const vec = Array(dimensions).fill(0.1),
        service = createLoreService({
          repositories: repos,
          charId: "char",
          embedding: { embed: async () => vec, embedQuery: async () => vec },
          model: {
            complete: async () => {
              modelCalls++;
              return "1. Secret one\n2. Secret two";
            },
          },
        });
      const id = await service.applySessionLoreOverride(
        authored.id,
        "override one",
        "b1",
      );
      assert.equal(
        await service.applySessionLoreOverride(
          authored.id,
          "override two",
          "b2",
        ),
        id,
      );
      assert.equal((await repos.facts.get(id))!.text, "override two");
      assert.equal(
        (await second.lore.getAllOverridesForSession())[authored.id],
        undefined,
      );
      const secrets = await service.ensureSecretsIndexed(authored);
      assert.equal(secrets.length, 2);
      await service.ensureSecretsIndexed(authored);
      assert.equal(modelCalls, 1);
      await service.applySecretReveal(secrets[0]!.id, secrets[0]!.text, "b2");
      assert.equal(
        (await repos.lore.revealedIds(secrets.map((s) => s.id))).size,
        1,
      );
      assert.equal(
        (await second.lore.revealedIds(secrets.map((s) => s.id))).size,
        0,
      );
      assert.equal((await repos.facts.listAll()).length, 2);
      assert.equal((await second.facts.listAll()).length, 0);
      const stats = await service.rollbackSessionLore(["b2"]);
      assert.deepEqual(stats, {
        overrides_reverted: 0,
        overrides_restored: 1,
        reveals_deleted: 1,
      });
      assert.equal((await repos.facts.get(id))!.text, "override one");
      assert.equal((await repos.facts.listAll()).length, 1);
      const candidates = await service.fetchCandidates([authored], null, {}, 3);
      assert.deepEqual(
        candidates.map((c) => [c.id, c.text]),
        [["authored", "override one"]],
      );
      const raw = await db.query<{ text: string }>(
        `SELECT text FROM "${scope.schemaName}".memory_facts WHERE id=$1`,
        [id],
      );
      assert.match(raw.rows[0]!.text, /^enc:/);
      assert.ok(!raw.rows[0]!.text.includes("override"));
    } finally {
      await db.close();
    }
  });
test("multi-chunk indexing stores only successful source part ids and preserves gaps", async () => {
  const db = await createMemoryDatabase();
  try {
    await ensureRegistry(db);
    const profile = await new ProfileRepository(db, {
      encrypt: (s) => s,
      decrypt: (s) => s,
    }).create("owner", {
      baseUrl: "http://test",
      model: "test",
      dimensions: 1,
    });
    await ensureProfileSchema(db, profile);
    const scope = {
      profileId: profile.id,
      schemaName: profile.schemaName,
      ownerUserId: "owner",
      sessionId: "one",
      charId: "char",
    };
    await ensureIdentity(db, scope);
    const repos = createMemoryRepositories(db, scope, Buffer.alloc(32, 1));
    const content = [
      "good ".repeat(260),
      "bad ".repeat(320),
      "last ".repeat(260),
    ].join("\n\n");
    const lore = await repos.lore.upsert({
      id: "chunks",
      name: "Archive",
      category: "Documents",
      content,
    });
    const calls: string[] = [];
    const service = createLoreService({
      repositories: repos,
      charId: "char",
      model: {} as any,
      embedding: {
        embed: async (text) => {
          calls.push(text);
          if (text.includes("bad")) throw new Error("offline");
          return [1];
        },
        embedQuery: async () => [1],
      },
    });
    await service.indexLoreEntry(lore);
    assert.deepEqual(
      (await repos.lore.chunksFor(lore.id)).map((c) => c.part_id),
      [0, 2],
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every((text) => text.startsWith("Documents, Archive: ")));
    const hits = await repos.vectors.searchLoreChunks([1], 32, 0.8);
    assert.deepEqual(hits.map((h) => h.part_id).sort(), [0, 2]);
  } finally {
    await db.close();
  }
});

// Exact source instruct expression from isolated ai_helpers.py at the pinned commit.
const sourceSecretPrompt =
  'You decompose hidden lore entries for a roleplay platform into a numbered list of short, independent facts, so a player can learn one without the others being revealed or implied.\nRules:\n1. Each fact must stand completely on its own — a reader who only sees one fact must not be able to guess or infer any other fact.\n2. Never combine two separate pieces of information into one fact, even if they\'re related. Example: "She secretly likes sweets but hates cake" must become TWO facts — "She has a sweet tooth" and "She dislikes cake" — never one, since knowing the first should never imply the second.\n3. Paraphrase in your own words — do not quote more than a few consecutive words of the source directly.\n4. Reply with ONLY a numbered list ("1. ", "2. ", ...), one fact per line, no preamble, no headers, no code fences.\n\nInput:\nhidden';
test("secret extraction prompt matches isolated Python reference bytes", () =>
  assert.equal(buildSecretExtractionPrompt("hidden"), sourceSecretPrompt));
