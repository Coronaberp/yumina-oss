import { describe, it, expect } from "vitest";
import { chapterSchema } from "../story/chapters.js";
import { chapterEventIssues } from "../story/chapter-event-schema.js";
import { chapterEventContext, chapterEventPrompt, advanceChapterEvents } from "../story/chapter-events.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockWorld, createMockEntry, createMockGameState } from "./test-utils.js";

const world = () => createMockWorld({
  variables: [{ id: "gate", name: "Gate ready", type: "boolean", defaultValue: false }, { id: "mei-code", name: "Mei Code", type: "string", defaultValue: "HOPE" }, { id: "reward", name: "Reward", type: "number", defaultValue: 0 }],
  entries: [createMockEntry({ id: "opening", role: "greeting" }), createMockEntry({ id: "hope" }), createMockEntry({ id: "seraph", enabled: false })],
  chapters: [chapterSchema.parse({ id: "holder", name: "Holder", greetingIds: ["opening"], events: [{ id: "clash", name: "Fated Clash", enabled: true, conditions: [{ variableId: "gate", operator: "eq", value: true }], scenes: [
    { id: "briefing", name: "Briefing", instructions: "Blair briefs the party.", requiredMoments: [{ id: "mission", description: "Blair explains that the gate can open only once." }] },
    { id: "awakening", name: "Awakening", instructions: "Mei evolves into CODE[SERAPH].", requiredMoments: [{ id: "evolve", description: "Mei visibly evolves from HOPE into SERAPH." }], effects: [{ variableId: "mei-code", operation: "set", value: "SERAPH" }], entryChanges: [{ entryId: "hope", enabled: false }, { entryId: "seraph", enabled: true }] },
  ], effects: [{ variableId: "reward", operation: "add", value: 1 }] }] })],
});
const manager = () => new GameStateManager(world(), createMockGameState({ activeChapterId: "holder", variables: { gate: true, "mei-code": "HOPE", reward: 0 } }));
const evidence = (sceneId: string, momentId: string, quote: string) => ({ chapterId: "holder", eventId: "clash", sceneId, narrative: quote, moments: [{ momentId, quote }] });

describe("chapter events", () => {
  it("keeps started events active after a prerequisite is consumed and pauses disabled definitions", () => {
    const card = world(), sm = new GameStateManager(card, manager().getSnapshot());
    sm.set("gate", false);
    expect(chapterEventContext(card, sm.getSnapshot())?.scene.id).toBe("briefing");
    card.chapters![0]!.events![0]!.enabled = false;
    expect(chapterEventContext(card, sm.getSnapshot())).toBeUndefined();
    card.chapters![0]!.events![0]!.enabled = true;
    expect(chapterEventContext(card, sm.getSnapshot())?.scene.id).toBe("briefing");
    const snapshot = sm.getSnapshot(); chapterEventPrompt(card, snapshot);
    expect(sm.getSnapshot()).toEqual(snapshot);
  });
  it("accumulates moments across turns and waits for additional state gates", () => {
    const card = world(), scene = card.chapters![0]!.events![0]!.scenes[0]!;
    scene.requiredMoments.push({ id: "ready", description: "Blair activates her Code." });
    scene.completionConditions = [{ variableId: "reward", operator: "gte", value: 1 }];
    const sm = new GameStateManager(card, manager().getSnapshot());
    advanceChapterEvents(card, sm, evidence("briefing", "mission", "The gate can open only once."));
    sm.incrementTurn();
    advanceChapterEvents(card, sm, evidence("briefing", "ready", "Blair activates her Code."));
    expect(chapterEventContext(card, sm.getSnapshot())?.remainingMoments).toEqual([]);
    expect(chapterEventContext(card, sm.getSnapshot())?.scene.id).toBe("briefing");
    sm.set("reward", 1);
    advanceChapterEvents(card, sm, { chapterId: "holder", eventId: "clash", sceneId: "briefing", narrative: "The party is ready.", moments: [] });
    expect(chapterEventContext(card, sm.getSnapshot())?.scene.id).toBe("awakening");
  });
  it("validates incomplete enabled scenes, duplicate IDs and missing effect/condition/lore references", () => {
    const card = world(), event = card.chapters![0]!.events![0]!;
    event.scenes[0]!.requiredMoments = [];
    event.scenes.push(structuredClone(event.scenes[1]!));
    event.conditions.push({ variableId: "missing", operator: "eq", value: true });
    event.effects.push({ variableId: "absent", operation: "set", value: 1 });
    event.effects.push({ variableId: "reward", operation: "set", value: "invalid number" });
    event.entryChanges.push({ entryId: "nonexistent", enabled: true });
    const issues = chapterEventIssues(card).join("\n");
    expect(issues).toContain("add required moments"); expect(issues).toContain("duplicate scene ID");
    expect(issues).toContain("condition variable missing"); expect(issues).toContain("effect variable absent"); expect(issues).toContain("lore entry nonexistent");
    expect(issues).toContain("incompatible effect for reward");
    expect(chapterEventContext(card, manager().getSnapshot())).toBeUndefined();
  });
  it("roundtrips definitions and requires active chapter and prerequisites", () => {
    expect(world().chapters![0]!.events).toHaveLength(1);
    expect(chapterEventContext(world(), new GameStateManager(world()).getSnapshot())).toBeUndefined();
    expect(chapterEventContext(world(), manager().getSnapshot())?.scene.id).toBe("briefing");
    expect(chapterEventContext(world(), { ...manager().getSnapshot(), activeChapterId: "other" })).toBeUndefined();
  });
  it("prompts only the current scene and never leaks later transformation details", () => {
    const prompt = chapterEventPrompt(world(), manager().getSnapshot());
    expect(prompt).toContain("Blair briefs"); expect(prompt).not.toContain("SERAPH");
  });
  it("detaches event progress in both snapshot directions", () => {
    const sm = manager(), snapshot = sm.getSnapshot();
    const progress = Object.values(snapshot.storyEvents!)[0]!;
    progress.status = "completed";
    expect(chapterEventContext(world(), sm.getSnapshot())?.scene.id).toBe("briefing");
    const restored = new GameStateManager(world(), snapshot);
    progress.status = "active";
    expect(chapterEventContext(world(), restored.getSnapshot())).toBeUndefined();
  });
  it("rejects wrong scenes, unknown moments and invented quotes", () => {
    const sm = manager();
    advanceChapterEvents(world(), sm, evidence("awakening", "evolve", "Mei evolves into CODE[SERAPH]."));
    expect(chapterEventContext(world(), sm.getSnapshot())?.scene.id).toBe("briefing");
    advanceChapterEvents(world(), sm, { ...evidence("briefing", "mission", "The gate opens only once."), narrative: "Everyone waits." });
    advanceChapterEvents(world(), sm, evidence("briefing", "unknown", "The gate opens only once."));
    expect(chapterEventContext(world(), sm.getSnapshot())?.scene.id).toBe("briefing");
    expect(sm.get("reward")).toBe(0);
  });
  it("advances one scene at a time, persists evidence and applies effects exactly once", () => {
    let sm = manager();
    advanceChapterEvents(world(), sm, evidence("briefing", "mission", "Blair explains that the gate opens only once."));
    expect(chapterEventContext(world(), sm.getSnapshot())?.scene.id).toBe("awakening");
    sm = new GameStateManager(world(), sm.getSnapshot());
    expect(chapterEventContext(world(), sm.getSnapshot())?.scene.id).toBe("awakening");
    const before = sm.getSnapshot();
    const changes = advanceChapterEvents(world(), sm, evidence("awakening", "evolve", "Mei's HOPE evolves into CODE[SERAPH]."));
    expect(changes.map(c => c.variableId)).toContain("mei-code");
    expect(sm.get("mei-code")).toBe("SERAPH"); expect(sm.get("reward")).toBe(1);
    expect(sm.getSnapshot().ruleState?.toggledEntries).toMatchObject({ hope: false, seraph: true });
    expect(chapterEventContext(world(), sm.getSnapshot())).toBeUndefined();
    advanceChapterEvents(world(), sm, evidence("awakening", "evolve", "Mei's HOPE evolves into CODE[SERAPH]."));
    expect(sm.get("reward")).toBe(1);
    expect(chapterEventContext(world(), new GameStateManager(world(), before).getSnapshot())?.scene.id).toBe("awakening");
  });
});
