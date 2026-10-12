import { describe, expect, it } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import { worldDefinitionSchema } from "../world/schema.js";
import type { GameEvent, Reaction } from "../events/types.js";
import { createMockGameState, createMockVariable, createMockWorld } from "./test-utils.js";

const config = {
  type: "progression:resolve",
  checkpointVariableId: "checkpoints",
  maxProgress: 1500,
  ladders: { social: [
    { label: "Hatred", capacity: 100 },
    { label: "Neutral", capacity: 100 },
    { label: "Friendly", capacity: 200 },
    { label: "Trusted", capacity: 400, milestone: "trusted" },
  ] },
  tracks: ["alice", "bob"].map(id => ({
    scoreVariableId: id, stateVariableId: `${id}-state`, ladder: "social",
    defaultState: "Neutral", aliases: { Familiar: "Friendly" },
    milestoneVariables: { trusted: `${id}-trusted` },
  })),
};
const reaction: Reaction = {
  id: "progression", name: "Social progression", when: { eventType: "turn:complete" },
  conditions: [], conditionLogic: "all", then: [{ type: "emit", event: config }], priority: -1000, enabled: true,
};
const world = createMockWorld({
  reactions: [reaction],
  variables: [
    ...["alice", "bob"].flatMap(id => [
      createMockVariable({ id, name: id, defaultValue: 0 }),
      createMockVariable({ id: `${id}-state`, name: `${id}-state`, type: "string", defaultValue: "Neutral" }),
      createMockVariable({ id: `${id}-trusted`, name: `${id}-trusted`, type: "boolean", defaultValue: false }),
    ]),
    createMockVariable({ id: "checkpoints", name: "checkpoints", type: "json", defaultValue: {} }),
  ],
});
function make(variables: Record<string, any> = {}) {
  return new GameStateManager(world, createMockGameState({ worldId: world.id, variables }));
}
function turn(manager: GameStateManager, effects: Array<{ variableId: string; operation: "set" | "add"; value: any }> = []) {
  const changes = manager.applyEffects(effects);
  return runReactionChain(new ReactionEvaluator(), manager, [
    { type: "turn:complete" }, ...changes.map(c => ({ type: "state:changed", ...c })),
  ], world.reactions!, []);
}

describe("declarative stage progression", () => {
  it("advances once after an actual action and checkpoints the reset", () => {
    const m = make({ alice: 99, checkpoints: { alice: { last: 99 } } });
    const result = turn(m, [{ variableId: "alice", operation: "add", value: 1 }]);
    expect(m.get("alice-state")).toBe("Friendly");
    expect(m.get("alice")).toBe(0);
    expect((m.get("checkpoints") as any).alice.last).toBe(0);
    expect(result.firedIds).toEqual(["progression"]);
    expect(result.changes.some(c => c.variableId === "alice-state")).toBe(true);
    expect(m.get("bob-state")).toBe("Neutral");
  });
  it("does not advance full bars or existing milestones on idle saved turns", () => {
    const m = make({ alice: 200, "alice-state": "Friendly", "alice-trusted": true });
    turn(m);
    expect(m.get("alice-state")).toBe("Friendly");
    expect(m.get("alice")).toBe(200);
  });
  it("requires earned milestones and handles milestone-only changes", () => {
    const m = make({ alice: 199, "alice-state": "Friendly", checkpoints: { alice: { last: 199 } } });
    turn(m, [{ variableId: "alice", operation: "add", value: 1 }]);
    expect(m.get("alice-state")).toBe("Friendly");
    turn(m, [{ variableId: "alice-trusted", operation: "set", value: true }]);
    expect(m.get("alice-state")).toBe("Trusted");
    expect(m.get("alice")).toBe(0);
  });
  it("demotes once and revokes lost milestones", () => {
    const m = make({ alice: -399, "alice-state": "Trusted", "alice-trusted": true, checkpoints: { alice: { last: -399 } } });
    turn(m, [{ variableId: "alice", operation: "add", value: -1 }]);
    expect(m.get("alice-state")).toBe("Friendly");
    expect(m.get("alice")).toBe(0);
    expect(m.get("alice-trusted")).toBe(false);
  });
  it("restores malformed legacy scores without granting an action", () => {
    const m = make({ alice: "100", checkpoints: { alice: { last: 100, pending: false } } });
    turn(m);
    expect(m.get("alice")).toBe(100);
    expect(m.get("alice-state")).toBe("Neutral");
  });
  it("repairs legacy labels and clamps to the stored stage on idle turns", () => {
    const m = make({ alice: 800, "alice-state": "Familiar" });
    turn(m);
    expect(m.get("alice-state")).toBe("Friendly");
    expect(m.get("alice")).toBe(200);
  });
  it("validates malformed event configuration before any mutation", () => {
    const m = make({ alice: 100, "alice-state": "Neutral" });
    const bad = structuredClone(reaction);
    (bad.then[0] as { type: "emit"; event: GameEvent }).event = { ...config, ladders: { social: [{ label: "Neutral", capacity: 0 }] } };
    const before = m.getSnapshot().variables;
    runReactionChain(new ReactionEvaluator(), m, [{ type: "turn:complete" }], [bad], []);
    expect(m.getSnapshot().variables).toEqual(before);
  });
  it("preserves malformed milestone checkpoint values without treating them as earned", () => {
    const m = make({ alice: 200, "alice-state": "Friendly", "alice-trusted": "true" });
    turn(m);
    expect(m.get("alice-state")).toBe("Friendly");
    expect((m.get("checkpoints") as any).alice.milestones["alice-trusted"]).toBe("true");
  });
  it("retains the configured event through normal world schema parsing", () => {
    expect(worldDefinitionSchema.parse(world).reactions![0]!.then).toEqual(reaction.then);
  });
});
