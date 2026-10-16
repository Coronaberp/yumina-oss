import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryService } from "./service.js";
import type { TurnMemoryContext } from "./types.js";
import {renderCluster} from './block.js';
import { estimateTokens as promptTokens } from '@yumina/engine';
const scope = {
  profileId: "profile",
  schemaName: "shm_" + "a".repeat(32),
  ownerUserId: "owner",
  sessionId: "session",
  charId: "char",
};
function context(n: number): TurnMemoryContext {
  return {
    ownerUserId: "owner",
    actingUserId: "actor",
    sessionId: "session",
    worldId: "world",
    mode: "single",
    epoch: 0,
    sourceHash: "source",
    cutoffMessageId: `a${n - 1}`,
    query: "moment",
    messages: Array.from({ length: n }, (_, i) => [
      { id: `u${i}`, role: "user", content: `question ${i}` },
      { id: `a${i}`, role: "assistant", content: `answer ${i}` },
    ]).flat(),
    charName: "Mira",
    userName: "Player",
    language: "English",
    castNames: [],
    canonicalLocation: "town",
    loreEntries: [],
  };
}
function emptyRepos() {
  let cursor = 0;
  const batches: any[] = [],
    inserts: any[] = [],
    scene: any[] = [];
  const repositories: any = {
    facts: {
      context: { scope },
      getCursor: async () => cursor,
      setCursor: async (n: number) => {
        cursor = n;
      },
      recordBatch: async (...x: any[]) => batches.push(x),
      getSceneState: async () => ({
        doing: "waiting",
        location: "town",
        npcs: ["Zed"],
      }),
      setSceneState: async (...x: any[]) => scene.push(x),
      insert: async (...x: any[]) => {
        inserts.push(x);
        return `fact${inserts.length}`;
      },
      similarCurrent: async () => [],
      countUnclusteredSince: async () => 0,
      similarLive: async () => [],
      reserved: async () => [],
    },
    lore: {
      linksFor: async () => [],
      byIds: async () => [],
      getAllOverridesForSession: async () => ({}),
    },
    vectors: { searchLoreIds: async () => [], searchSecretIds: async () => [] },
    clusters: {
      latestForSession: async () => null,
      activeForSession: async () => [],
    },
  };
  return { repositories, batches, inserts, scene, cursor: () => cursor };
}
test('a failed extraction leaves its transcript batch available for a successful retry', async () => {
 const state=emptyRepos(); let failing=true;
 const service=createMemoryService({repositories:state.repositories,
  model:{complete:async()=>{if(failing)throw new Error('memory_model_request_failed');return '{"facts":[],"char_state":{"doing":"waiting","location":"town","npcs":[]}}';}},
  embedding:{embed:async()=>[1],embedQuery:async()=>[1]}});
 await assert.rejects(service.extractSettled(context(6)), /memory_model_request_failed/);
 assert.equal(state.cursor(),0);assert.deepEqual(state.batches,[]);assert.deepEqual(state.scene,[]);
 failing=false;await service.extractSettled(context(6));
 assert.equal(state.cursor(),5);assert.equal(state.batches.length,1);
});
test('invalid extraction JSON cannot be committed as an empty successful batch', async () => {
 const state=emptyRepos();
 const service=createMemoryService({repositories:state.repositories,model:{complete:async()=> 'not JSON'},embedding:{embed:async()=>[1],embedQuery:async()=>[1]}});
 await assert.rejects(service.extractSettled(context(6)));
 assert.equal(state.cursor(),0);assert.deepEqual(state.batches,[]);assert.deepEqual(state.scene,[]);
});
test('request-bounded recall counts its headings and never expands a zero budget', async () => {
 const state=emptyRepos();
 state.repositories.vectors.searchLoreChunks=async()=>[];
 state.repositories.facts.reserved=async()=>Array.from({length:12},(_,i)=>({id:`fact-${i}`,text:`Mira remembers promise ${i}.`,fact_type:'promise',participants:['Mira'],importance:5,valence:0,reinforcements:0,last_turn:1,valid_until_turn:null,pinned:true}));
 const service=createMemoryService({repositories:state.repositories,model:{complete:async()=>{throw new Error('Recall never generates text');}},embedding:{embed:async()=>[1],embedQuery:async()=>[1]}});
 const count=(text:string)=>promptTokens(text,'custom/test');
 const result=await service.retrieveBlock({...context(6),memoryBudgetTokens:30,promptTokenCounter:count} as any);
 assert.ok(count(result.block)<=30,`Rendered recall costs ${count(result.block)} tokens for a 30-token allowance`);
 const empty=await service.retrieveBlock({...context(6),memoryBudgetTokens:0,promptTokenCounter:count} as any);
 assert.equal(empty.block,'');assert.deepEqual(empty.usedIds,[]);
});
test('service forwards editable source limits to extraction, lore searches and block allocation',async()=>{
 const state=emptyRepos(),seen:number[]=[];
 state.repositories.vectors.searchLoreIds=async(_v:number[],k:number)=>{seen.push(k);return [];};
 state.repositories.vectors.searchSecretIds=async(_v:number[],k:number)=>{seen.push(k);return [];};
 state.repositories.vectors.searchLoreChunks=async(_v:number[],k:number)=>{seen.push(k);return [];};
 const drafts=Array.from({length:4},(_,i)=>({text:`Fact ${i}`,fact_type:'event',participants:[],importance:3,valence:0}));
 const service=createMemoryService({repositories:state.repositories,model:{complete:async p=>p.startsWith('Analyze')?JSON.stringify({facts:drafts,char_state:{}}):p.startsWith("You maintain a story's memory database")?'[{"index":0,"action":"add"},{"index":1,"action":"add"}]':'[]'},embedding:{embed:async()=>[1],embedQuery:async()=>[1]},config:{maxFactsPerBatch:2,loreNeighborK:7,loreCandidateK:9,reservedFraction:0,clusterBudgetTokens:10,memoryBudgetTokens:20}});
 await service.extractSettled(context(6));assert.equal(state.inserts.length,2);assert.deepEqual(seen,[7,7,7,7]);
 const cluster={id:'c',summary_text:'word '.repeat(80),created_turn:5};
 state.repositories.clusters.latestForSession=async()=>cluster;
 state.repositories.facts.reserved=async()=>[{id:'p',text:'Pinned',fact_type:'event',participants:[],importance:3,valence:0,reinforcements:0,last_turn:1,valid_until_turn:null,pinned:true}];
 const result=await service.retrieveBlock(context(6));assert.equal(seen.at(-1),9);assert.deepEqual(result.usedIds,[]);assert.equal(result.block,renderCluster(cluster,{clusterBudgetTokens:10}));
});
test("source 5+1 settlement and 15-pair catch-up produce exact pair windows and user turns", async () => {
  for (const [pairs, wanted] of [
    [5, []],
    [6, [[0, 5, 5]]],
    [
      15,
      [
        [0, 5, 5],
        [5, 10, 10],
        [10, 14, 14],
      ],
    ],
  ] as const) {
    const state = emptyRepos();
    const service = createMemoryService({
      repositories: state.repositories,
      model: { complete: async () => '{"facts":[],"char_state":{}}' },
      embedding: { embed: async () => [1], embedQuery: async () => [1] },
    });
    await service.extractSettled(context(pairs));
    assert.deepEqual(
      state.batches.map((b) => b.slice(1)),
      wanted,
    );
    assert.equal(state.cursor(), pairs === 5 ? 0 : pairs - 1);
  }
});
test("batch provider results finish before fenced mutation and snapshots; scene names fold once", async () => {
  const state = emptyRepos();
  let committing = false;
  const events: string[] = [];
  const replies = [
    '{"facts":[{"text":"A promise","fact_type":"promise","participants":[],"importance":4,"valence":1}],"char_state":{"doing":"walking","location":"forest","npcs":["Ada","Zed"]}}',
    '[{"index":0,"action":"add"}]',
  ];
  const service = createMemoryService({
    repositories: state.repositories,
    model: {
      complete: async () => {
        assert.equal(committing, false);
        events.push("model");
        return replies.shift()!;
      },
    },
    embedding: {
      embed: async () => {
        assert.equal(committing, false);
        events.push("embed");
        return [1];
      },
      embedQuery: async () => [1],
    },
    onBatchCommit: async (meta, write) => {
      events.push(meta.phase);
      committing = true;
      await write(state.repositories);
      committing = false;
    },
    onBatchCommitted: async () => {
      events.push("snapshot");
    },
  });
  await service.extractSettled(context(6));
  assert.deepEqual(state.scene, [["walking", "forest", ["Ada", "Zed"]]]);
  assert.deepEqual(state.inserts[0][0].participants, ["Player", "Mira"]);
  assert.equal(state.inserts[0][0].location, "forest");
  assert.deepEqual(events, [
    "model",
    "embed",
    "model",
    "embed",
    "embed",
    "facts",
    "snapshot",
  ]);
});
test("failed fact embeddings and rejected fencing cannot advance cursor or commit facts", async () => {
  const output =
    '{"facts":[{"text":"A fact","fact_type":"event","participants":[],"importance":3,"valence":0}],"char_state":{}}';
  const one = emptyRepos();
  await assert.rejects(
    createMemoryService({
      repositories: one.repositories,
      model: { complete: async () => output },
      embedding: {
        embed: async () => {
          throw new Error("offline");
        },
        embedQuery: async () => [1],
      },
    }).extractSettled(context(6)),
    /offline/,
  );
  assert.equal(one.cursor(), 0);
  assert.deepEqual(one.scene, []);
  const two = emptyRepos();
  await assert.rejects(
    createMemoryService({
      repositories: two.repositories,
      model: { complete: async () => '{"facts":[],"char_state":{}}' },
      embedding: {} as any,
      onBatchCommit: async () => {
        throw new Error("stale claim");
      },
    }).extractSettled(context(6)),
    /stale claim/,
  );
  assert.equal(two.cursor(), 0);
  assert.deepEqual(two.batches, []);
});
test("retrieval packs ranked memory before ranked lore, uses query prefix API, and reports exact lines", async () => {
  const state = emptyRepos();
  const fact = {
    id: "memory",
    text: "old promise",
    fact_type: "event",
    participants: ["Player"],
    importance: 3,
    valence: 0,
    reinforcements: 0,
    last_turn: 1,
    valid_until_turn: null,
    pinned: false,
    distance: 0.8,
  };
  state.repositories.facts.similarLive = async () => [fact];
  state.repositories.lore.byIds = async () => [
    { id: "lore", name: "Lore", content: "world detail", char_id: "char" },
  ];
  state.repositories.lore.chunksFor = async () => [];
  state.repositories.vectors.searchLoreChunks = async () => [
    { lore_id: "lore", part_id: 0, distance: 0 },
  ];
  const queries: string[] = [];
  const service = createMemoryService({
    repositories: state.repositories,
    model: {} as any,
    embedding: {
      embed: async () => {
        throw new Error("raw query forbidden");
      },
      embedQuery: async (q) => {
        queries.push(q);
        return [1];
      },
    },
  });
  const result = await service.retrieveBlock(context(6));
  assert.deepEqual(queries, ["moment"]);
  assert.deepEqual(result.usedIds, ["memory", "lore"]);
  assert.deepEqual(result.memoryLines, ["- old promise"]);
  assert.deepEqual(result.loreLines, ["- world detail"]);
  assert.equal(result.profileId, "profile");
});
test("empty query/no lore preserves source early return and cross-owner context is rejected", async () => {
  const state = emptyRepos();
  state.repositories.facts.reserved = async () => {
    throw new Error("must not read");
  };
  const service = createMemoryService({
    repositories: state.repositories,
    embedding: {} as any,
    model: {} as any,
  });
  const ctx = { ...context(1), query: "" };
  assert.equal((await service.retrieveBlock(ctx)).block, "");
  await assert.rejects(
    service.retrieveBlock({ ...ctx, ownerUserId: "other" }),
    /scope/,
  );
});
test("source rollback locates selected assistant pair then deletes overlapping lore and clusters", async () => {
  const state = emptyRepos(),
    calls: any[] = [];
  state.repositories.facts.batches = async () => [
    { id: "batch", pair_start: 0, pair_end: 5 },
  ];
  state.repositories.facts.rollbackFromPairIndex = async (i: number) => {
    calls.push(["rollback", i]);
    return {
      batches_rolled_back: 1,
      facts_deleted: 1,
      rewound_cursor: 0,
      batch_ids: ["batch"],
    };
  };
  state.repositories.lore.statesForBatches = async () => [];
  state.repositories.lore.deleteRevealsForBatches = async (ids: string[]) => {
    calls.push(["reveals", ids]);
    return 1;
  };
  state.repositories.clusters.deleteOverlapping = async (ids: string[]) => {
    calls.push(["clusters", ids]);
    return 2;
  };
  const service = createMemoryService({
    repositories: state.repositories,
    embedding: {} as any,
    model: {} as any,
  });
  assert.equal(await service.rollbackDiscardedTurn(context(3), "u1"), null);
  const result = await service.rollbackDiscardedTurn(context(3), "a1");
  assert.deepEqual(calls, [
    ["rollback", 1],
    ["reveals", ["batch"]],
    ["clusters", ["batch"]],
  ]);
  assert.equal(result?.clusters_deleted, 2);
});
test("rollback mutation uses the same acceptance fence as batch writes", async () => {
  const state = emptyRepos();
  let changed = false;
  state.repositories.facts.batches = async () => [
    { id: "batch", pair_start: 0, pair_end: 5 },
  ];
  state.repositories.facts.rollbackFromPairIndex = async () => {
    changed = true;
    return { batch_ids: ["batch"] };
  };
  state.repositories.lore.statesForBatches = async () => [];
  state.repositories.lore.deleteRevealsForBatches = async () => 0;
  state.repositories.clusters.deleteOverlapping = async () => 0;
  const service = createMemoryService({
    repositories: state.repositories,
    model: {} as any,
    embedding: {} as any,
    onBatchCommit: async () => {
      throw new Error("stale claim");
    },
  });
  await assert.rejects(
    service.rollbackDiscardedTurn(context(6), "a1"),
    /stale claim/,
  );
  assert.equal(changed, false);
});
test("invalid extraction batch sizes are rejected before they can prevent cursor progress", () => {
  const state = emptyRepos();
  for (const batchSize of [0, -1, 1.5, NaN])
    assert.throws(
      () =>
        createMemoryService({
          repositories: state.repositories,
          model: {} as any,
          embedding: {} as any,
          config: { batchSize },
        }),
      /batch size/i,
    );
});
