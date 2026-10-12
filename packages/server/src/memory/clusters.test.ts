import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createClusterService,
  parseClusterAssignments,
  runClusterAssign,
} from "./clusters.js";
import type { MemoryModel } from "./types.js";
const facts = Array.from({ length: 8 }, (_, i) => ({
  id: `f${i}`,
  text: `fact ${i}`,
  last_turn: i + 1,
  batch_id: i < 4 ? "b1" : "b2",
}));
function model(replies: (string | Error)[]): MemoryModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: async (prompt) => {
      calls.push(prompt);
      const result = replies.shift();
      if (result instanceof Error) throw result;
      return result ?? "";
    },
  };
}
test("source cluster parser permits partial/duplicate assignment but rejects invalid targets/ranges", () => {
  assert.deepEqual(
    parseClusterAssignments(
      '{"clusters":[{"title":"new","summary":"x","fact_indices":["1",true,1]}]}',
      3,
      new Set(),
    ),
    [{ id: null, title: "new", summary: "x", fact_indices: [1, 1, 1] }],
  );
  assert.deepEqual(
    parseClusterAssignments('{"clusters":[]}', 3, new Set()),
    [],
  );
  for (const raw of [
    "[]",
    '{"clusters":[{"id":"missing","summary":"x","fact_indices":[0]}]}',
    '{"clusters":[{"title":"x","summary":"x","fact_indices":[-1]}]}',
    '{"clusters":[{"title":"x","summary":"","fact_indices":[0]}]}',
  ])
    assert.throws(() => parseClusterAssignments(raw, 3, new Set()));
});
test("cluster assignment retries invalid JSON once and falls back without a third invocation", async () => {
  const invalid = model(["bad", "bad"]);
  assert.deepEqual(await runClusterAssign([], facts, invalid), [
    {
      id: null,
      title: "Untitled thread",
      summary: "fact 0 fact 1 fact 2 fact 3 fact 4 fact 5 fact 6 fact 7",
      fact_indices: [0, 1, 2, 3, 4, 5, 6, 7],
    },
  ]);
  assert.equal(invalid.calls.length, 2);
  assert.match(
    invalid.calls[1]!,
    /Reply again with only the corrected JSON\.$/,
  );
  const network = model([new Error("offline")]);
  await runClusterAssign([], facts, network);
  assert.equal(network.calls.length, 1);
});
test("single-thread cluster evolves prior summary and preserves raw fact fallback with eight-fact trigger", async () => {
  const writes: any[] = [];
  const m = model([new Error("offline")]);
  const service = createClusterService({
    model: m,
    embedding: { embed: async () => [1], embedQuery: async () => [1] },
    repositories: {
      facts: { countUnclusteredSince: async () => 8 },
      clusters: {
        insert: async (...args: any[]) => {
          writes.push(args);
          return "cluster";
        },
      },
    } as any,
  });
  assert.equal(await service.shouldBuildCluster("previous-batch"), true);
  assert.equal(
    await service.buildCluster(facts, ["b1", "b2"], "earlier story"),
    "cluster",
  );
  assert.deepEqual(writes, [
    [
      "earlier story fact 0 fact 1 fact 2 fact 3 fact 4 fact 5 fact 6 fact 7",
      8,
      ["b1", "b2"],
      "",
      undefined,
    ],
  ]);
  assert.match(m.calls[0]!, /Here is the story so far:\n\nearlier story/);
});
test("multi-thread clustering prepares provider results before committing scoped updates and memberships", async () => {
  let inCommit = false;
  const writes: any[] = [];
  const m = model([
    '{"clusters":[{"id":"existing","summary":"evolved","fact_indices":[0,1]},{"title":"new thread","summary":"new","fact_indices":[2]}]}',
  ]);
  const embedding = {
    embed: async (text: string) => {
      assert.equal(inCommit, false);
      if (text === "new") throw new Error("offline");
      return [1];
    },
    embedQuery: async () => [1],
  };
  const repos = {
    clusters: {
      activeForSession: async () => [
        {
          id: "existing",
          title: "old",
          summary_text: "old",
          created_turn: 0,
          source_batch_ids: [],
        },
      ],
      updateCluster: async (...args: any[]) => writes.push(["update", ...args]),
      insert: async (...args: any[]) => {
        writes.push(["insert", ...args]);
        return "new-id";
      },
      addMembers: async (...args: any[]) => writes.push(["members", ...args]),
    },
  };
  const service = createClusterService({
    model: m,
    embedding,
    repositories: repos,
  } as any);
  const prepared = await service.prepareAssignments(facts);
  assert.deepEqual(writes, []);
  inCommit = true;
  assert.equal(await service.commitAssignments(prepared, repos as any), 2);
  assert.deepEqual(writes, [
    ["update", "existing", "evolved", 2, ["b1"], [1]],
    ["members", "existing", ["f0", "f1"]],
    ["insert", "new", 3, ["b1"], "new thread", undefined],
    ["members", "new-id", ["f2"]],
  ]);
});

// Generated from pinned source _parse_cluster_assign in isolation, Pydantic 2.12.5.
const sourceValidationFixtures = [
  {
    raw: '{"clusters":[{"title":"x","summary":"","fact_indices":[0]}]}',
    error:
      "1 validation error for ClusterAssignment\nsummary\n  String should have at least 1 character [type=string_too_short, input_value='', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.12/v/string_too_short",
  },
  {
    raw: '{"clusters":[{"summary":"x","fact_indices":[0]}]}',
    error:
      "1 validation error for ClusterAssignment\n  Value error, assignment requires either id (existing cluster) or title (new cluster) [type=value_error, input_value={'summary': 'x', 'fact_indices': [0]}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.12/v/value_error",
  },
  {
    raw: '{"clusters":[{"title":"x","summary":"x","fact_indices":[1.5]}]}',
    error:
      "1 validation error for ClusterAssignment\nfact_indices.0\n  Input should be a valid integer, got a number with a fractional part [type=int_from_float, input_value=1.5, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.12/v/int_from_float",
  },
];
test("cluster retry validation errors match isolated Python reference bytes", () => {
  for (const row of sourceValidationFixtures)
    assert.throws(
      () => parseClusterAssignments(row.raw, 3, new Set()),
      (e) => e instanceof Error && e.message === row.error,
    );
});
test("noniterable cluster payload follows source fallback without a validation retry", async () => {
  const m = model(['{"clusters":1}']);
  await runClusterAssign([], facts, m);
  assert.equal(m.calls.length, 1);
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
  test(`real multi-thread cluster membership/evolution/rollback remains session scoped at ${dimensions}`, async () => {
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
        second = createMemoryRepositories(db, other, Buffer.alloc(32, 1)),
        vec = Array(dimensions).fill(1);
      for (let i = 0; i < 8; i++)
        await repos.facts.insert(
          {
            text: `fact ${i}`,
            fact_type: "event",
            participants: [],
            importance: 3,
            valence: 0,
            turn: i + 1,
            batch_id: "b1",
          },
          vec,
        );
      const old = await repos.clusters.insert(
        "earlier",
        0,
        ["earlier-batch"],
        "Old arc",
        vec,
      );
      const unrelated = await second.clusters.insert(
        "unrelated",
        9,
        ["b1"],
        "Other",
        vec,
      );
      const m = model([
        JSON.stringify({
          clusters: [
            { id: old, summary: "evolved", fact_indices: [0, 1, 2, 3] },
            { title: "New arc", summary: "new", fact_indices: [4, 5, 6, 7] },
          ],
        }),
      ]);
      const service = createClusterService({
        repositories: repos,
        embedding: { embed: async () => vec, embedQuery: async () => vec },
        model: m,
      });
      const unclustered = await service.shouldBuildClusterMulti();
      assert.equal(unclustered.length, 8);
      assert.equal(await service.assignAndBuildClusters(unclustered), 2);
      assert.equal((await repos.clusters.unclusteredFacts()).length, 0);
      const clusters = await repos.clusters.activeForSession();
      assert.deepEqual(
        clusters.map((c) => [c.title, c.summary_text, c.created_turn]),
        [
          ["New arc", "new", 8],
          ["Old arc", "evolved", 4],
        ],
      );
      assert.deepEqual(clusters[1]!.source_batch_ids, ["b1", "earlier-batch"]);
      assert.equal((await repos.vectors.searchClusterIds(vec, 10)).length, 2);
      assert.equal(await repos.clusters.deleteOverlapping(["b1"]), 2);
      assert.equal((await repos.clusters.activeForSession()).length, 0);
      assert.equal((await repos.vectors.searchClusterIds(vec, 10)).length, 0);
      assert.equal((await second.clusters.latestForSession())!.id, unrelated);
    } finally {
      await db.close();
    }
  });
