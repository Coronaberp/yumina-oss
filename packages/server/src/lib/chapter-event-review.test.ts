import assert from "node:assert/strict";
import { test } from "node:test";
import { chapterSchema, GameStateManager, type WorldDefinition } from "@yumina/engine";
import { reviewChapterEventMoments } from "./chapter-event-review.js";
const world = { id: "qa", name: "QA", entries: [], variables: [], rules: [], chapters: [chapterSchema.parse({ id: "holder", name: "Holder", events: [{ id: "clash", name: "Clash", enabled: true, scenes: [{ id: "evolution", name: "Evolution", instructions: "Mei evolves.", requiredMoments: [{ id: "seraph", description: "Mei transforms into CODE[SERAPH]." }] }] }] })] } as unknown as WorldDefinition;
const state = () => new GameStateManager(world, { worldId: "qa", activeChapterId: "holder", variables: {}, metadata: {}, turnCount: 1 }).getSnapshot();
test("reviews only current required moments and accepts exact narrative evidence", async () => {
  const narrative = "Mei's Code blazes as she transforms into CODE[SERAPH].";
  const result = await reviewChapterEventMoments({ world, state: state(), narrative, request: async request => {
    assert.equal(request.stage, "review"); assert.deepEqual(request.history, []);
    assert.match(String(request.messages.at(-1)!.content), /seraph/);
    return { raw: JSON.stringify({ moments: [{ momentId: "seraph", quote: narrative }] }) };
  } });
  assert.equal(result?.sceneId, "evolution"); assert.equal(result?.moments.length, 1);
});
test("missing, invented, unknown and malformed evidence never completes a moment", async () => {
  for (const raw of ['{"complete":true}', '{"moments":[{"momentId":"seraph","quote":"Not in the actual story."}]}', '{"moments":[{"momentId":"future","quote":"Everyone waits patiently."}]}', 'broken']) {
    const result = await reviewChapterEventMoments({ world, state: state(), narrative: "Everyone waits patiently.", request: async () => ({ raw }) });
    assert.deepEqual(result?.moments, []);
  }
});
test("review failure leaves the scene pending without rejecting the narrative", async () => {
  const result = await reviewChapterEventMoments({ world, state: state(), narrative: "Everyone waits patiently.", request: async () => { throw new Error("upstream timeout"); } });
  assert.deepEqual(result?.moments, []);
});
test("no active event performs no review request", async () => {
  let calls = 0;
  const result = await reviewChapterEventMoments({ world, state: { ...state(), activeChapterId: "other" }, narrative: "Everyone waits patiently.", request: async () => { calls++; return { raw: "{}" }; } });
  assert.equal(result, undefined); assert.equal(calls, 0);
});
