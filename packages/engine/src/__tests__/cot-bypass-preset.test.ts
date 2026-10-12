import { describe, expect, it } from "vitest";
import { OFFICIAL_PRESETS } from "../entries/official-presets.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockEntry, createMockGameState, createMockWorld } from "./test-utils.js";

const legacy = "<think>\nDon't overthink, let the story develop. Therefore, no more pre-thinking needed.\n</think>";
const entry = (content = legacy, presetId: string | undefined = "cot-bypass") => createMockEntry({ name: "CoT Bypass", presetId, content, section: "post-history", apiRole: "user", enabled: true, alwaysSend: true });

describe("CoT Bypass prompt role", () => {
  it("new official presets cannot become the latest player message or emit thinking wrappers", () => {
    const preset = OFFICIAL_PRESETS.find(p => p.presetId === "cot-bypass")!;
    expect(preset.apiRole).toBe("system");
    expect(preset.content).not.toMatch(/<\/?think>/);
    expect(preset.content).toMatch(/latest player/i);
  });
  it("upgrades the exact saved preset in memory and leaves the saved entry intact", () => {
    const saved = entry();
    const world = createMockWorld({ entries: [saved] });
    const result = new PromptBuilder().buildPostHistoryEntries(world, createMockGameState());
    expect(result[0]!.apiRole).toBe("system");
    expect(result[0]!.content).toBe(OFFICIAL_PRESETS.find(p => p.presetId === "cot-bypass")!.content);
    expect(saved.content).toBe(legacy);
    expect(saved.apiRole).toBe("user");
  });
  it("preserves customized entries and unlabelled matching prose", () => {
    const customized = entry(legacy + "\nCustom ending instruction.");
    const unlabelled = entry(legacy); delete unlabelled.presetId;
    const world = createMockWorld({ entries: [customized, unlabelled] });
    expect(new PromptBuilder().buildPostHistoryEntries(world, createMockGameState())).toEqual([
      { content: customized.content, apiRole: "user" }, { content: legacy, apiRole: "user" },
    ]);
  });
  it("cost analysis measures the same upgraded post-history text as runtime assembly", () => {
    const world = createMockWorld({ entries: [entry()] });
    const builder = new PromptBuilder(), state = createMockGameState();
    const content = OFFICIAL_PRESETS.find(p => p.presetId === "cot-bypass")!.content;
    expect(builder.buildPromptCostBreakdown(world, state).blocks.find(b => b.label === "CoT Bypass")!.chars).toBe(content.length);
    expect(builder.buildPostHistoryEntries(world, state, undefined, undefined, world.entries)[0]!.apiRole).toBe("system");
  });
});
