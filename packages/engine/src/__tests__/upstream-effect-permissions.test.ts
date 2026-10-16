import { expect, test } from "vitest";
import { filterAiEffects } from "../state/variable-activation.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockWorld } from "./test-utils.js";

test("AI write checks resolve display names and bracket roots like the state manager", () => {
  const world = createMockWorld({ variables: [
    { id: "locked", name: "Locked counter", type: "number", defaultValue: 1, aiAccess: "read" },
    { id: "list", name: "List", type: "json", defaultValue: [1], aiAccess: "read" },
    { id: "open", name: "Writable counter", type: "number", defaultValue: 0 },
  ] });
  const effects = [
    { variableId: "Locked counter", operation: "set" as const, value: 99 },
    { variableId: "list[0]", operation: "set" as const, value: 99 },
    { variableId: "Writable counter", operation: "add" as const, value: 2 },
  ];
  const manager = new GameStateManager(world);
  const { kept, dropped } = filterAiEffects(world, manager.getSnapshot(), effects);
  expect(dropped).toEqual(effects.slice(0, 2));
  expect(kept).toEqual([effects[2]]);
  manager.applyEffects(kept);
  expect(manager.get("locked")).toBe(1);
  expect(manager.get("open")).toBe(2);
});

test("IDs take precedence over aliases and duplicate display names resolve last", () => {
  const world = createMockWorld({ variables: [
    { id: "open", name: "Other", type: "number", defaultValue: 0 },
    { id: "locked", name: "open", type: "number", defaultValue: 0, aiAccess: "read" },
    { id: "first", name: "Shared", type: "number", defaultValue: 0 },
    { id: "last", name: "Shared", type: "number", defaultValue: 0, aiAccess: "read" },
  ] });
  const effects = [
    { variableId: "open", operation: "add" as const, value: 1 },
    { variableId: "Shared", operation: "add" as const, value: 1 },
  ];
  const filtered = filterAiEffects(world, new GameStateManager(world).getSnapshot(), effects);
  expect(filtered.kept).toEqual([effects[0]]);
  expect(filtered.dropped).toEqual([effects[1]]);
});
