import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import {
  registerExtensionHooks,
  __setInstalledLookupForTests,
} from "./extension-hooks.js";
import * as pipeline from "./turn-memory.js";
import type { TurnMemoryContext } from "../memory/types.js";
import type {WorldDefinition} from '@yumina/engine';
const context: TurnMemoryContext = {
  ownerUserId: "owner",
  actingUserId: "actor",
  sessionId: "session",
  worldId: "world",
  mode: "solo",
  epoch: 7,
  sourceHash: "prefix-7",
  cutoffMessageId: null,
  query: "raw query",
  messages: [],
  charName: "Mira",
  userName: "Player",
  language: "English",
  castNames: [],
  canonicalLocation: "",
  loreEntries: [],
};
test('source prompt world excludes lore and opted-in custom entries without changing the indexed world',()=>{
 const world={entries:[{id:'lore',role:'lore'},{id:'private',role:'custom',memory:{hidden:true}},{id:'visible',role:'custom',memory:{}},{id:'instructions',role:'custom'},{id:'character',role:'character'}]} as unknown as WorldDefinition;
 assert.equal(pipeline.worldForTurnMemoryPrompt(world,{}),world);
 const prompt=pipeline.worldForTurnMemoryPrompt(world,{storyhaven:{context,adapter:{} as any}});
 assert.deepEqual(prompt.entries.map(entry=>entry.id),['instructions','character']);assert.equal(world.entries.length,5);
});
function fixture(enabled = true) {
  const calls: { retrieve: unknown[]; updates: unknown[]; legacy: string[] } = {
    retrieve: [],
    updates: [],
    legacy: [],
  };
  let current = true;
  const adapter = {
    retrieveStoryhavenMemory: async (input: unknown) => {
      calls.retrieve.push(input);
      return {
        enabled,
        context: { ...context, backend: enabled ? "storyhaven" : "legacy" },
        result: {
          block: "## Recalled from earlier\n- Earlier fact.",
          status: "ready",
        },
      };
    },
    ensureStoryhavenSnapshotCurrent: async () => current,
    scheduleStoryhavenMemory: async (...args: unknown[]) => {
      calls.updates.push(args);
    },
  };
  registerExtensionHooks(SESSION_MEMORY_EXTENSION_KEY, {
    contributePromptBlocks: () => {
      calls.legacy.push("blocks");
      return [{ id: "legacy", content: "LEGACY MEMORY", priority: 1 }];
    },
    filterHistory: () => {
      calls.legacy.push("filter");
      return [sql`compacted=false`];
    },
    onPromptOverflow: async () => {
      calls.legacy.push("overflow");
    },
    onTurnComplete: () => {
      calls.legacy.push("update");
    },
  });
  registerExtensionHooks("state-update-guard", {
    contributePromptBlocks: () => [
      { id: "other", content: "OTHER EXTENSION", priority: 5 },
    ],
    onTurnComplete: () => calls.legacy.push("other-update"),
  });
  __setInstalledLookupForTests(
    async () => new Set([SESSION_MEMORY_EXTENSION_KEY, "state-update-guard"]),
  );
  const args = {
    ownerUserId: "owner",
    actingUserId: "actor",
    sessionId: "session",
    session: { sessionMemoryPinned: "Player standing note." },
    model: "actor-model",
    query: "raw query",
    cutoffMessageId: "old-answer",
  };
  return {
    calls,
    adapter,
    args,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
test("StoryHaven selection excludes every legacy memory hook and keeps other extensions and standing notes", async (t) => {
  const f = fixture();
  t.after(() => __setInstalledLookupForTests(null));
  const turn = await pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any);
  assert.equal(
    turn.dispatch.activeExtensions.has(SESSION_MEMORY_EXTENSION_KEY),
    false,
  );
  assert.equal(turn.dispatch.activeExtensions.has("state-update-guard"), true);
  assert.deepEqual(turn.historyConditions, []);
  assert.deepEqual(f.calls.legacy, []);
  assert.deepEqual(f.calls.retrieve, [
    {
      ownerUserId: "owner",
      actingUserId: "actor",
      sessionId: "session",
      model: "actor-model",
      query: "raw query",
      cutoffMessageId: "old-answer",
      world: undefined,
    },
  ]);
  assert.ok(
    turn.blocks.some(
      (block) =>
        block.id === "storyhaven-memory" &&
        block.content?.includes("Earlier fact."),
    ),
  );
  assert.ok(
    turn.blocks.some(
      (block) =>
        block.id === "session-memory-pinned" &&
        block.content?.includes("Player standing note."),
    ),
  );
  const prompt: pipeline.TurnPromptMessage[] = [];
  pipeline.injectMemoryPromptBlocks(prompt, turn);
  assert.ok(prompt.some((row) => row.content === "OTHER EXTENSION"));
  assert.ok(!prompt.some((row) => row.content.includes("LEGACY MEMORY")));
  pipeline.scheduleTurnMemoryUpdates({
    turn,
    sessionId: "session",
    userId: "actor",
    userMessage: "question",
    assistantMessage: "answer",
    state: {},
    fallbackModel: "actor-model",
    assistantMessageId: "reply",
    contextTokenLimit: 1000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.updates, [["session", "actor", "actor-model"]]);
  assert.deepEqual(f.calls.legacy, ["other-update"]);
});
test("legacy backend retains its prompt, history filtering and post-turn dispatch", async (t) => {
  const f = fixture(false);
  t.after(() => __setInstalledLookupForTests(null));
  const turn = await pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any);
  assert.equal(
    turn.dispatch.activeExtensions.has(SESSION_MEMORY_EXTENSION_KEY),
    true,
  );
  assert.equal(turn.historyConditions.length, 1);
  assert.ok(turn.blocks.some((block) => block.id === "legacy"));
  assert.deepEqual(f.calls.legacy, ["blocks", "filter"]);
  assert.ok(!turn.blocks.some((block) => block.id === "storyhaven-memory"));
});
test("fresh start and unconfigured StoryHaven preserve notes while suppressing derived and legacy content", async (t) => {
  const f = fixture();
  t.after(() => __setInstalledLookupForTests(null));
  const turn = await pipeline.loadTurnMemoryBlocks(
    { ...f.args, suppressSummaryBlocks: true },
    f.adapter as any,
  );
  assert.equal(
    turn.dispatch.activeExtensions.has(SESSION_MEMORY_EXTENSION_KEY),
    false,
  );
  assert.equal(
    turn.blocks.find((block) => block.id === "storyhaven-memory")?.content,
    null,
  );
  assert.match(
    turn.blocks.find((block) => block.id === "session-memory-pinned")!.content!,
    /Player standing note/,
  );
  f.adapter.retrieveStoryhavenMemory = async () => ({
    enabled: true,
    context: { ...context, backend: "storyhaven" },
    result: { block: "", status: "unconfigured" },
  });
  const empty = await pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any);
  assert.equal(empty.historyConditions.length, 0);
  assert.equal(
    empty.dispatch.activeExtensions.has(SESSION_MEMORY_EXTENSION_KEY),
    false,
  );
  assert.equal(
    empty.blocks.find((block) => block.id === "storyhaven-memory")?.content,
    null,
  );
});
test("paused retrieval retries once and rejects a second changed snapshot", async (t) => {
  const f = fixture();
  t.after(() => __setInstalledLookupForTests(null));
  let checks = 0;
  f.adapter.ensureStoryhavenSnapshotCurrent = async () => ++checks > 1;
  await pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any);
  assert.equal(f.calls.retrieve.length, 2);
  f.setCurrent(false);
  f.adapter.ensureStoryhavenSnapshotCurrent = async () => false;
  await assert.rejects(
    pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any),
    { name: "TurnMemoryChangedError", code: "TURN_CHANGED" },
  );
  assert.equal(f.calls.retrieve.length, 4);
});
test("dispatch rejects changed source and transactional persistence locks/checks captured epoch", async (t) => {
  const f = fixture();
  t.after(() => __setInstalledLookupForTests(null));
  const turn = await pipeline.loadTurnMemoryBlocks(f.args, f.adapter as any);
  f.setCurrent(false);
  await assert.rejects(pipeline.assertTurnMemoryCurrent(turn), {
    code: "TURN_CHANGED",
  });
  let checked = false;
  const tx = {
    execute: async () => {
      checked = true;
      return { rows: [{ epoch: 8, backend: "storyhaven", user_id: "owner" }] };
    },
  };
  await assert.rejects(
    pipeline.assertTurnMemoryCommitCurrent(turn, tx as any),
    { code: "TURN_CHANGED" },
  );
  assert.ok(checked);
  await pipeline.assertTurnMemoryCommitCurrent(turn, {
    execute: async () => ({
      rows: [{ epoch: 7, backend: "storyhaven", user_id: "owner" }],
    }),
  } as any);
});
