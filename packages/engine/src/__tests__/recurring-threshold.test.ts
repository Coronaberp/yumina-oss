import { describe, expect, it } from "vitest";
import type { Reaction } from "../events/types.js";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { eventPatternSchema, triggerConfigSchema } from "../world/schema.js";
import { createMockGameState, createMockRule, createMockVariable, createMockWorld } from "./test-utils.js";

function crossing(
  threshold = 29,
  direction: "rises-above" | "drops-below" | undefined = "rises-above",
  repeatEvery: number | undefined = 30,
): Reaction {
  return {
    id: "moon", name: "Blood Moon",
    when: {
      eventType: "state:crossed",
      match: {
        variableId: { operator: "eq", value: "day" },
        threshold: { operator: "eq", value: threshold },
        ...(direction ? { direction: { operator: "eq" as const, value: direction } } : {}),
        ...(repeatEvery !== undefined ? { repeatEvery: { operator: "eq" as const, value: repeatEvery } } : {}),
      },
    },
    conditions: [], conditionLogic: "all",
    then: [{ type: "set", path: "fires", value: 1, operation: "add" }],
    priority: 0, enabled: true,
  };
}

const evaluator = new ReactionEvaluator();
function fired(reaction: Reaction, oldValue: number, newValue: number, variableId = "day") {
  return evaluator.evaluate(
    { type: "state:changed", variableId, oldValue, newValue },
    [reaction], [], createMockGameState({ variables: { day: newValue }, turnCount: 7 }),
  ).firedIds;
}

describe("recurring variable threshold crossings", () => {
  it("rises monthly on Academy days 30, 60 and 90, independent of turn count", () => {
    const days = Array.from({ length: 95 }, (_, index) => index + 1);
    expect(days.filter(day => fired(crossing(), day - 1, day).length > 0)).toEqual([30, 60, 90]);
  });

  it("wanes on days 33, 63 and 93 using the existing strict threshold 32", () => {
    const days = Array.from({ length: 95 }, (_, index) => index + 1);
    expect(days.filter(day => fired(crossing(32), day - 1, day).length > 0)).toEqual([33, 63, 93]);
  });

  it.each([[28, 29], [58, 59], [88, 89]])("does not rise when %i→%i only reaches a boundary", (oldValue, newValue) => {
    expect(fired(crossing(), oldValue, newValue)).toEqual([]);
  });

  it.each([[29, 30], [59, 60], [89, 90]])("rises when %i→%i leaves a boundary", (oldValue, newValue) => {
    expect(fired(crossing(), oldValue, newValue)).toEqual(["moon"]);
  });

  it.each([[60, 59], [30, 29]])("does not drop when %i→%i only reaches a boundary", (oldValue, newValue) => {
    expect(fired(crossing(29, "drops-below"), oldValue, newValue)).toEqual([]);
  });

  it.each([[59, 58], [29, 28]])("drops when %i→%i leaves a repeated boundary", (oldValue, newValue) => {
    expect(fired(crossing(29, "drops-below"), oldValue, newValue)).toEqual(["moon"]);
  });

  it("supports either direction when direction is omitted", () => {
    const reaction = crossing();
    delete reaction.when.match!.direction;
    expect(fired(reaction, 59, 60)).toEqual(["moon"]);
    expect(fired(reaction, 59, 58)).toEqual(["moon"]);
  });

  it("does not invent boundaries before the initial threshold", () => {
    expect(fired(crossing(), -2, 0)).toEqual([]);
    expect(fired(crossing(29, "drops-below"), 0, -2)).toEqual([]);
    expect(fired(crossing(), 0, 28)).toEqual([]);
  });

  it.each([[30, 31], [60, 61], [59, 59], [60, 60], [61, 60]])("ignores same-side, unchanged or reverse-only rise events %i→%i", (oldValue, newValue) => {
    expect(fired(crossing(), oldValue, newValue)).toEqual([]);
  });

  it("ignores changes to unrelated variables", () => {
    expect(fired(crossing(), 59, 60, "other")).toEqual([]);
  });

  it("fires once for a jump spanning multiple monthly boundaries", () => {
    expect(fired(crossing(), 40, 100)).toEqual(["moon"]);
    expect(fired(crossing(29, "drops-below"), 100, 40)).toEqual(["moon"]);
  });

  it("crosses computed fractional boundaries without quotient-rounding skips", () => {
    const boundary = 3 * 0.1;
    expect(fired(crossing(0, "rises-above", 0.1), boundary, boundary + 0.05)).toEqual(["moon"]);
    expect(fired(crossing(0, "drops-below", 0.1), boundary, boundary - 0.05)).toEqual(["moon"]);
  });

  it.each([0, -30, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid repeatEvery=%s rather than falling back to a one-shot", repeatEvery => {
    expect(fired(crossing(29, "rises-above", repeatEvery), 29, 30)).toEqual([]);
  });

  it("preserves one-shot crossing semantics when recurrence is absent", () => {
    const reaction = crossing();
    delete reaction.when.match!.repeatEvery;
    expect(fired(reaction, 29, 30)).toEqual(["moon"]);
    expect(fired(reaction, 59, 60)).toEqual([]);
    expect(fired(reaction, 0, 100)).toEqual(["moon"]);
  });

  it("preserves recurrence through a JSON/native event-pattern schema roundtrip", () => {
    const pattern = crossing().when;
    expect(eventPatternSchema.parse(JSON.parse(JSON.stringify(pattern)))).toEqual(pattern);
  });

  it("preserves legacy recurrence through a JSON/trigger-schema roundtrip", () => {
    const trigger = { type: "variable-crossed", variableId: "day", direction: "rises-above", threshold: 29, repeatEvery: 30 };
    expect(triggerConfigSchema.parse(JSON.parse(JSON.stringify(trigger)))).toEqual(trigger);
  });

  it("supports repeated thresholds on legacy rules as well as native reactions", () => {
    const rule = createMockRule({ id: "legacy-moon", trigger: {
      type: "variable-crossed", variableId: "day", direction: "rises-above", threshold: 29, repeatEvery: 30,
    } });
    const days = Array.from({ length: 95 }, (_, index) => index + 1);
    expect(days.filter(day => evaluator.evaluate(
      { type: "state:changed", variableId: "day", oldValue: day - 1, newValue: day },
      [], [rule], createMockGameState({ variables: { day }, turnCount: 7 }),
    ).firedIds.length > 0)).toEqual([30, 60, 90]);
  });

  it("runs monthly rise/wane effects and preserves their duration across reload", () => {
    const world = createMockWorld({ variables: [
      createMockVariable({ id: "day", name: "Academy Day", defaultValue: 0 }),
      createMockVariable({ id: "active", name: "Blood Moon", type: "boolean", defaultValue: false }),
      createMockVariable({ id: "heat", name: "Heat", defaultValue: 0 }),
    ] });
    const rises = { ...crossing(), id: "rises", then: [
      { type: "set" as const, path: "active", value: true },
      { type: "set" as const, path: "heat", value: 60 },
    ] };
    const wanes = { ...crossing(32), id: "wanes", then: [
      { type: "set" as const, path: "active", value: false },
      { type: "set" as const, path: "heat", value: 0 },
    ] };
    let manager = new GameStateManager(world);
    const riseDays: number[] = [];
    const waneDays: number[] = [];
    for (let day = 1; day <= 94; day++) {
      manager.set("day", day);
      const result = runReactionChain(evaluator, manager,
        [{ type: "state:changed", variableId: "day", oldValue: day - 1, newValue: day }], [rises, wanes], []);
      if (result.firedIds.includes("rises")) riseDays.push(day);
      if (result.firedIds.includes("wanes")) waneDays.push(day);
      const active = day >= 30 && day % 30 < 3;
      expect(manager.get("active"), `active on day ${day}`).toBe(active);
      expect(manager.get("heat"), `heat on day ${day}`).toBe(active ? 60 : 0);
      expect(manager.get("day")).toBe(day);
      if (day === 45) manager = new GameStateManager(world, manager.getSnapshot());
    }
    expect(riseDays).toEqual([30, 60, 90]);
    expect(waneDays).toEqual([33, 63, 93]);
  });

  it("continues to enforce max-fire limits and turn-based cooldowns", () => {
    const world = createMockWorld({ variables: [
      createMockVariable({ id: "day", defaultValue: 0 }),
      createMockVariable({ id: "fires", defaultValue: 0 }),
    ] });
    const reaction = { ...crossing(), maxFireCount: 2, cooldownTurns: 2 };
    const manager = new GameStateManager(world);
    const evaluateAt = (day: number, turnCount: number) => {
      manager.loadSnapshot({ ...manager.getSnapshot(), turnCount, variables: { ...manager.getSnapshot().variables, day } });
      return runReactionChain(evaluator, manager,
        [{ type: "state:changed", variableId: "day", oldValue: day - 1, newValue: day }], [reaction], []).firedIds;
    };
    expect(evaluateAt(30, 1)).toEqual(["moon"]);
    expect(evaluateAt(60, 2)).toEqual([]);
    expect(evaluateAt(90, 3)).toEqual(["moon"]);
    expect(evaluateAt(120, 5)).toEqual([]);
    expect(manager.get("fires")).toBe(2);
  });
});
