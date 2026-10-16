import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterSchema, GameStateManager, ReactionEvaluator, runReactionChain, type WorldDefinition } from "@yumina/engine";
import { settleChapterEventTurn } from "./chapter-event-turn.js";

test("event rewards feed Behaviors without firing an earlier reaction twice", () => {
  const world: WorldDefinition = { id: "events", name: "Events", version: "21.0.0", author: "QA", description: "", rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: .8 }, entries: [], variables: ["reward", "unlocked", "hits"].map(id => ({ id, name: id, type: "number", defaultValue: 0 })), chapters: [chapterSchema.parse({ id: "c", name: "Chapter", events: [{ id: "e", name: "Event", enabled: true, scenes: [{ id: "s", name: "Scene", requiredMoments: [{ id: "m", description: "The gate opens." }] }], effects: [{ variableId: "reward", operation: "add", value: 1 }] }] })], reactions: [
    { id: "broad", name: "Broad", enabled: true, when: { eventType: "state:changed" }, conditions: [], conditionLogic: "all", then: [{ type: "set", path: "hits", operation: "add", value: 1 }], priority: 0 },
    { id: "unlock", name: "Unlock", enabled: true, when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "reward" } } }, conditions: [], conditionLogic: "all", then: [{ type: "set", path: "unlocked", operation: "set", value: 1 }], priority: 0 },
  ] };
  const manager = new GameStateManager(world, { worldId: world.id, activeChapterId: "c", variables: { reward: 0, unlocked: 0, hits: 0 }, turnCount: 1, metadata: {} });
  const evaluator = new ReactionEvaluator();
  const previous = runReactionChain(evaluator, manager, [{ type: "state:changed", variableId: "other", oldValue: 0, newValue: 1 }], world.reactions!, []);
  const evidence = { chapterId: "c", eventId: "e", sceneId: "s", narrative: "The gate opens.", moments: [{ momentId: "m", quote: "The gate opens." }] };
  const result = settleChapterEventTurn(world, manager, evaluator, evidence, previous);
  assert.equal(manager.get("reward"), 1);
  assert.equal(manager.get("unlocked"), 1);
  assert.equal(manager.get("hits"), 1);
  assert.deepEqual(result.firedIds, ["broad", "unlock"]);
  assert.deepEqual(result.changes.map(c => c.variableId), ["hits", "reward", "unlocked"]);
  settleChapterEventTurn(world, manager, evaluator, evidence, result);
  assert.equal(manager.get("reward"), 1);
});
