import { describe, expect, it } from "vitest";
import { lorebookEntrySchema, worldEntrySchema } from "../world/schema.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockEntry, createMockGameState, createMockWorld } from "./test-utils.js";

const memory = { hidden: true, metadata: { category: "history", tags: ["secret"] }, links: [{ targetId: "other", label: "before" }], secrets: ["A concealed truth"] };
describe("StoryHaven authored lore", () => {
  it("preserves memory fields in current and imported entry schemas", () => {
    expect(worldEntrySchema.parse({ ...createMockEntry(), memory }).memory).toEqual(memory);
    expect(lorebookEntrySchema.parse({ id: "old", name: "Old", type: "lore", content: "text", memory }).memory).toEqual(memory);
  });
  it("rejects invalid metadata values", () => {
    expect(worldEntrySchema.safeParse({ ...createMockEntry(), memory: { metadata: { broken: 4 } } }).success).toBe(false);
  });
  it("keeps hidden lore out of matched, always-send and toggle-enabled normal prompts", () => {
    const hidden = { ...createMockEntry({ role: "lore", alwaysSend: true }), memory };
    const visible = createMockEntry({ role: "lore", alwaysSend: true });
    const world = createMockWorld({ entries: [hidden, visible] });
    expect(new PromptBuilder().collectEntries(world, [hidden], undefined, { [hidden.id]: true }).map(e => e.id)).toEqual([visible.id]);
  });
  it("omits hidden triggered messages and design-time token costs", () => {
    const builder = new PromptBuilder(); const state = createMockGameState();
    const hidden = { ...createMockEntry({ name: "Hidden cost", role: "lore", alwaysSend: false }), memory };
    expect(builder.buildTriggeredSystemMessages(createMockWorld(), state, [hidden], { [hidden.id]: true })).toEqual([]);
    const world = createMockWorld({ entries: [{ ...hidden, alwaysSend: true }] });
    expect(JSON.stringify(builder.buildPromptCostBreakdown(world, state))).not.toContain("Hidden cost");
  });
  it("does not expose hidden lore through precollected depth or post-history entries", () => {
    const builder = new PromptBuilder(); const world = createMockWorld(); const state = createMockGameState();
    const depth = { ...createMockEntry({ section: "chat-history", depth: 1 }), memory };
    const post = { ...createMockEntry({ section: "post-history" }), memory };
    expect(builder.buildDepthEntries(world, state, undefined, undefined, undefined, [depth])).toEqual([]);
    expect(builder.buildPostHistoryEntries(world, state, undefined, undefined, [post])).toEqual([]);
  });
});
