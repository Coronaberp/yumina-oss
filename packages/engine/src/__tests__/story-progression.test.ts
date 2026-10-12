import { describe, expect, it } from "vitest";
import type { GameState, WorldDefinition } from "../types/index.js";
import { completeStoryEnding, getStoryValidationIssues, resolveStoryProgress } from "../story/progression.js";

const baseState = (variables: Record<string, unknown> = {}): GameState => ({
  worldId: "w", variables: variables as GameState["variables"], turnCount: 4, metadata: {},
});
const baseWorld = (overrides: Partial<WorldDefinition> = {}): WorldDefinition => ({
  id: "w", version: "1", name: "W", description: "", author: "a", entries: [], variables: [
    { id: "trust", name: "Trust", type: "number", defaultValue: 0 },
  ], rules: [], components: [], settings: { storyStructureEnabled: true }, ...overrides,
});

describe("story progression", () => {
  it("selects routes by priority then lexical id and evaluates valueRef/all-any", () => {
    const world = baseWorld({ routes: [
      { id: "z", name: "Z", enabled: true, priority: 5, guidance: "z", conditions: [{ variableId: "trust", operator: "gte", value: 3 }], conditionLogic: "all", lockOnEntry: false },
      { id: "a", name: "A", enabled: true, priority: 5, guidance: "a", conditions: [{ variableId: "trust", operator: "gte", value: 3 }], conditionLogic: "all", lockOnEntry: false },
      { id: "bad", name: "Bad", enabled: true, priority: 100, guidance: "bad", conditions: [{ variableId: "missing", operator: "eq", valueRef: "trust", value: 3 }], conditionLogic: "any", lockOnEntry: false },
    ] });
    expect(resolveStoryProgress(world, baseState({ trust: 3 }), { selectEnding: false }).story?.route?.id).toBe("a");
  });

  it("freezes selected records, preserves locked deleted routes, and is idempotent for pending endings", () => {
    const world = baseWorld({ routes: [{ id: "r", name: "Route", enabled: true, priority: 1, guidance: "old", conditions: [], conditionLogic: "all", lockOnEntry: true }], endings: [{ id: "e", name: "End", enabled: true, priority: 1, routeIds: ["r"], conditions: [], conditionLogic: "all", allowUnconditional: true, outcome: "win", mode: "authored", prose: "Done", guidance: "" }] });
    const first = resolveStoryProgress(world, baseState(), { operationId: "op-1" });
    expect(first.story?.status).toBe("ending-ready");
    expect(first.story?.route?.guidance).toBe("old");
    const changed = baseWorld({ routes: [], endings: [] });
    const second = resolveStoryProgress(changed, first, { operationId: "op-2" });
    expect(second.story).toEqual(first.story);
  });

  it("rejects invalid enabled endings and requires pending nonempty completion", () => {
    const world = baseWorld({ endings: [{ id: "e", name: "E", enabled: true, priority: 1, routeIds: [], conditions: [], conditionLogic: "all", allowUnconditional: false, outcome: "", mode: "authored", prose: "", guidance: "" }] });
    expect(resolveStoryProgress(world, baseState()).story?.status).toBe("playing");
    expect(getStoryValidationIssues(world).some((x) => x.entityId === "e")).toBe(true);
    expect(() => completeStoryEnding(baseState(), "done")).toThrow();
    const pending = resolveStoryProgress(baseWorld({ endings: [{ id: "e", name: "E", enabled: true, priority: 1, routeIds: [], conditions: [], conditionLogic: "all", allowUnconditional: true, outcome: "win", mode: "authored", prose: "Done", guidance: "" }] }), baseState(), { operationId: "op" });
    expect(completeStoryEnding(pending, " final ").story?.status).toBe("completed");
  });
});

import { GameStateManager } from "../state/game-state-manager.js";
import { storyPromptBlock } from "../story/progression.js";

describe("story compatibility", () => {
  it("supports routes-only initialization, open-ended mode, and deep snapshot cloning", () => {
    const world = baseWorld({ routes: [{ id: "r", name: "R", enabled: true, priority: 1, guidance: "guide", conditions: [], conditionLogic: "all", lockOnEntry: false }], endings: [] });
    const manager = new GameStateManager(world, { ...baseState(), story: { status: "playing", route: { id: "old", name: "Old", guidance: "old", enteredTurn: 1, locked: false } } });
    const snapshot = manager.getSnapshot();
    expect(snapshot.story?.route?.id).toBe("old");
    snapshot.story!.route!.name = "changed";
    expect(manager.getSnapshot().story?.route?.name).toBe("Old");
    const structured = resolveStoryProgress(world, snapshot, { selectEnding: false });
    expect(structured.story?.route?.id).toBe("r");
    expect(storyPromptBlock(world, structured)).toContain("guide");
    const open = resolveStoryProgress({ ...world, settings: { storyStructureEnabled: false } }, structured);
    expect(open.story).toEqual(structured.story);
    structured.story!.route!.name = "mutated";
    expect(snapshot.story?.route?.name).toBe("changed");
  });
});

import type { Condition, StoryRoute, StoryEnding } from "../types/index.js";
import { worldDefinitionSchema, gameStateSchema } from "../world/schema.js";
import { mergeWorldDefinition } from "../world/merge.js";
import { diffWorldSchemas } from "../diff/world-diff.js";
const route = (patch: Partial<StoryRoute> = {}): StoryRoute => ({ id: "r", name: "Route", enabled: true, priority: 0, guidance: "Original", conditions: [], conditionLogic: "all", lockOnEntry: false, ...patch });
const ending = (patch: Partial<StoryEnding> = {}): StoryEnding => ({ id: "e", name: "Ending", enabled: true, priority: 0, routeIds: [], conditions: [{ variableId: "trust", operator: "gte", value: 3 }], conditionLogic: "all", allowUnconditional: false, outcome: "Alliance", mode: "authored", prose: "The allies depart together.", guidance: "", ...patch });

describe("story rules and provenance", () => {
  it("accepts declared JSON paths and variable references", () => {
    const world = baseWorld({ variables: [{ id: "stats", name: "Stats", type: "json", defaultValue: {} }, { id: "threshold", name: "Threshold", type: "number", defaultValue: 3 }], routes: [route({ conditions: [{ variableId: "stats.trust", operator: "gte", value: 0, valueRef: "threshold" }] })] });
    expect(resolveStoryProgress(world, baseState({ stats: { trust: 4 }, threshold: 3 })).story?.route?.id).toBe("r");
  });
  it("uses any logic without accepting undeclared references", () => {
    const conditions: Condition[] = [{ variableId: "trust", operator: "gte", value: 4 }, { variableId: "trust", operator: "eq", value: 3 }];
    expect(resolveStoryProgress(baseWorld({ endings: [ending({ conditions, conditionLogic: "any" })] }), baseState({ trust: 3 })).story?.status).toBe("ending-ready");
    expect(resolveStoryProgress(baseWorld({ endings: [ending({ conditions: [...conditions, { variableId: "missing", operator: "eq", value: 1 }], conditionLogic: "any" })] }), baseState({ trust: 3, missing: 1 })).story?.status).toBe("playing");
  });
  it("preserves locked deleted routes and captured guidance, but allows unlocked transitions", () => {
    const first = resolveStoryProgress(baseWorld({ routes: [route()] }), baseState(), { selectEnding: false });
    expect(resolveStoryProgress(baseWorld({ routes: [route({ guidance: "Edited" })] }), first).story?.route?.guidance).toBe("Original");
    expect(resolveStoryProgress(baseWorld({ routes: [route({ id: "next", priority: 9 })] }), first).story?.route?.id).toBe("next");
    const locked = resolveStoryProgress(baseWorld({ routes: [route({ lockOnEntry: true })] }), baseState(), { selectEnding: false });
    expect(resolveStoryProgress(baseWorld({ routes: [route({ id: "next", priority: 9 })] }), locked).story?.route).toEqual(locked.story?.route);
  });
  it("does not end on initialization, disabled drafts, or broken references", () => {
    const state = baseState({ trust: 4 });
    expect(resolveStoryProgress(baseWorld({ endings: [ending()] }), state, { selectEnding: false }).story?.status).toBe("playing");
    for (const patch of [{ enabled: false }, { routeIds: ["missing"] }, { conditions: [], allowUnconditional: false }]) {
      expect(resolveStoryProgress(baseWorld({ endings: [ending(patch)] }), state).story?.status).toBe("playing");
    }
    expect(resolveStoryProgress(baseWorld({ routes: [route(), route()], endings: [ending(), ending()] }), state).story).toEqual({ status: "playing" });
  });
  it("records a deterministic ending and keeps it through edits, disabling, and completion", () => {
    const first = resolveStoryProgress(baseWorld({ endings: [ending({ id: "b" }), ending({ id: "a" })] }), baseState({ trust: 4 }), { operationId: "stable" });
    expect(first.story?.ending?.id).toBe("a");
    const changed = resolveStoryProgress(baseWorld({ settings: { storyStructureEnabled: false }, endings: [ending({ id: "a", outcome: "Different" })] }), first);
    expect(changed.story).toEqual(first.story);
    const completed = completeStoryEnding(changed, "Final prose");
    expect(completed.story?.ending?.outcome).toBe("Alliance");
    expect(() => completeStoryEnding(completed, "Again")).toThrow();
    expect(first.story?.status).toBe("ending-ready");
  });
  it("round-trips old worlds, merges independent definitions, and marks story edits material", () => {
    const parsed = worldDefinitionSchema.parse(baseWorld());
    expect(parsed.routes).toEqual([]);
    expect(parsed.endings).toEqual([]);
    expect(parsed.settings.storyStructureEnabled).toBe(true);
    const base = baseWorld({ routes: [route()], endings: [ending()] });
    const merged = mergeWorldDefinition(base, { ...base, routes: [route({ guidance: "Local" })] }, { ...base, endings: [ending({ prose: "Server" })] });
    expect(merged.conflicts).toEqual([]);
    expect(merged.merged.routes?.[0]?.guidance).toBe("Local");
    expect(merged.merged.endings?.[0]?.prose).toBe("Server");
    expect(diffWorldSchemas(base, merged.merged).changes.map(c => c.kind).sort()).toEqual(["ending", "route"]);
    expect(diffWorldSchemas(base, { ...base, settings: { storyStructureEnabled: false } }).changes.some(c => c.id === "settings.storyStructureEnabled")).toBe(true);
    const state = resolveStoryProgress(base, baseState({ trust: 4 }));
    expect(gameStateSchema.parse(state).story).toEqual(state.story);
  });
});
