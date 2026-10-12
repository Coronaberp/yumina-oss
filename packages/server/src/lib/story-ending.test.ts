import assert from "node:assert/strict";
import test from "node:test";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { buildStoryEndingPrompt, completeAuthoredStoryEnding, evaluatePendingStoryEnding, validateStoryEndingPresentation } from "./story-ending.js";

const world = (mode: "authored" | "ai" = "authored"): WorldDefinition => ({
  id: "w", version: "1", name: "W", description: "", author: "a", entries: [], variables: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { storyStructureEnabled: true },
  endings: [{ id: "e", name: "End", enabled: true, priority: 1, routeIds: [], conditions: [], conditionLogic: "all", allowUnconditional: true, outcome: "Reach the gate", mode, prose: mode === "authored" ? "The gate closes." : "", guidance: mode === "ai" ? "Write a quiet conclusion." : "" }],
});
const state = (): GameState => ({ worldId: "w", variables: {}, turnCount: 3, metadata: {} });

test("evaluate persists ending-ready and captures operation id without changing source state", () => {
  const result = evaluatePendingStoryEnding(world(), state(), "op-1");
  assert.equal(result.story?.status, "ending-ready");
  assert.equal(result.story?.ending?.operationId, "op-1");
  assert.equal(state().story, undefined);
});

test("authored completion preserves captured outcome and rejects empty presentation", () => {
  const pending = evaluatePendingStoryEnding(world(), state(), "op-1");
  assert.throws(() => completeAuthoredStoryEnding(pending, "   "));
  const done = completeAuthoredStoryEnding(pending, "The gate closes.");
  assert.equal(done.story?.status, "completed");
  assert.equal(done.story?.ending?.outcome, "Reach the gate");
});

test("AI prompt is closing-only and output validation rejects choices/directives", () => {
  const pending = evaluatePendingStoryEnding(world("ai"), state(), "op-2");
  const prompt = buildStoryEndingPrompt(pending, "The scene is over.");
  assert.match(prompt[0]!.content, /Reach the gate/);
  assert.throws(() => validateStoryEndingPresentation("Done\n[CHOICES: A | B]"));
  assert.throws(() => validateStoryEndingPresentation("Done\n[CHOICES]"));
  assert.throws(() => validateStoryEndingPresentation("Done\n[state]"));
  assert.doesNotThrow(() => validateStoryEndingPresentation("[SPEAKER:Miveth:happy]\nThe words carry no accusation."));
  assert.throws(() => validateStoryEndingPresentation("Done\n[trust: set 9]"));
  assert.equal(validateStoryEndingPresentation("A quiet ending."), "A quiet ending.");
});
