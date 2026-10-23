import { describe, expect, it } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";

describe("named variable directives from upstream v0.80", () => {
  it("applies numeric effects to character names with middle dots or spaces", () => {
    const parser = new ResponseParser();
    const result = parser.parse("She nods. [relations.艾丝·华伦斯坦: +20] [relations.Riveria Ljos Alf: +1]");
    expect(result.cleanText).toBe("She nods.");
    expect(result.effects).toEqual([
      { variableId: "relations.艾丝·华伦斯坦", operation: "add", value: 20 },
      { variableId: "relations.Riveria Ljos Alf", operation: "add", value: 1 },
    ]);
  });

  it("parses balanced JSON for named paths and preserves bracketed prose", () => {
    const parser = new ResponseParser();
    const result = parser.parse('[Chapter One: Begin] She nods. [relations.リリ・アーデ: merge {"trust": 30, "notes": []}]');
    expect(result.cleanText).toBe("[Chapter One: Begin] She nods.");
    expect(result.effects).toEqual([
      { variableId: "relations.リリ・アーデ", operation: "merge", value: { trust: 30, notes: [] } },
    ]);
  });

  it("keeps named directives inside literal examples from changing state", () => {
    const parser = new ResponseParser();
    for (const input of [
      '`[relations.Riveria Ljos Alf: +1]`',
      '“[relations.リリ・アーデ: merge {"trust": 30}]”',
    ]) {
      const result = parser.parse(input);
      expect(result.cleanText).toBe(input);
      expect(result.effects).toEqual([]);
    }
  });
});
