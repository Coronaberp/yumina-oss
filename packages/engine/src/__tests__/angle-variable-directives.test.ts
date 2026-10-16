import { describe, expect, it } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";

describe("angle-bracket variable directive compatibility", () => {
  it("consumes the saved scene-period command and applies it to the declared variable", () => {
    const result = new ResponseParser().parse('The lamps glow.\n\n<current-period: set "evening">', undefined, ["current-period"]);
    expect(result.cleanText).toBe("The lamps glow.");
    expect(result.effects).toEqual([{ variableId: "current-period", operation: "set", value: "evening" }]);
    const state = new GameStateManager(createMockWorld({ variables: [createMockVariable({
      id: "current-period", name: "Scene Period", type: "string", defaultValue: "day", aiAccess: "write",
    })] }));
    expect(state.applyEffects(result.effects)).toEqual([{ variableId: "current-period", oldValue: "day", newValue: "evening" }]);
    expect(state.get("current-period")).toBe("evening");
  });

  it("resolves unique variable casing without creating a new state key", () => {
    const result = new ResponseParser().parse('<Current-period: SET "evening">\n<hp: -2>', undefined, ["current-period", "hp"]);
    expect(result.cleanText).toBe("");
    expect(result.effects).toEqual([
      { variableId: "current-period", operation: "set", value: "evening" }, { variableId: "hp", operation: "subtract", value: 2 },
    ]);
  });

  it("hides unknown angle commands and preserves literal examples without applying them", () => {
    const unknown = new ResponseParser().parse('<unknown: set "evening">', undefined, ["current-period"]);
    expect(unknown.cleanText).toBe(""); expect(unknown.effects).toEqual([]);
    for (const text of [ '`<current-period: set "evening">`',
      '```text\n<current-period: set "evening">\n```', '“Use <current-period: set evening> as an example.”', '<code><current-period: set evening></code>']) {
      const result = new ResponseParser().parse(text, undefined, ["current-period"]);
      expect(result.cleanText).toBe(text); expect(result.effects).toEqual([]);
    }
  });
});
