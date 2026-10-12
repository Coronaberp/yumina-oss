import { describe, expect, it } from "vitest";
import { personaPresetsSchema } from "../world/persona-presets.js";
import { mergeWorldDefinition } from "../world/merge.js";
import type { WorldDefinition } from "../types/index.js";

describe("creator persona presets", () => {
  const preset = { id: "student", name: "Student", appearance: "A blue coat", personality: "Curious", backstory: "A new arrival" };
  it("accepts descriptive identity only and rejects status-setting payloads", () => {
    expect(personaPresetsSchema.parse([preset])).toEqual([preset]);
    for (const field of ["initialVariables", "variables", "stats", "status", "effects", "note"]) {
      expect(personaPresetsSchema.safeParse([{ ...preset, [field]: { hp: 999 } }]).success).toBe(false);
    }
    expect(personaPresetsSchema.safeParse([preset, preset]).success).toBe(false);
    expect(personaPresetsSchema.safeParse([{ ...preset, name: " " }]).success).toBe(false);
  });
  it("accepts only the six supported persona sprite expressions", () => {
    const withSprites = { ...preset, sprites: { normal: "https://cdn.example/normal.png", shy: "https://cdn.example/shy.png" } };
    expect(personaPresetsSchema.parse([withSprites])).toEqual([withSprites]);
    expect(personaPresetsSchema.safeParse([{ ...preset, sprites: { surprised: "https://cdn.example/surprised.png" } }]).success).toBe(false);
    expect(personaPresetsSchema.safeParse([{ ...preset, sprites: { normal: "x".repeat(2049) } }]).success).toBe(false);
  });
  it("merges separate creator edits by ID without losing either persona", () => {
    const base = { personaPresets: [preset] } as unknown as WorldDefinition;
    const local = { ...base, personaPresets: [{ ...preset, personality: "Cautious" }] };
    const server = { ...base, personaPresets: [preset, { id: "visitor", name: "Visitor" }] };
    const result = mergeWorldDefinition(base, local, server);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.personaPresets).toEqual([{ ...preset, personality: "Cautious" }, { id: "visitor", name: "Visitor" }]);
  });
});
