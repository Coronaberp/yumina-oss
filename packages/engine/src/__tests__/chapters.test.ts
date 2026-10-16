import { describe, it, expect } from "vitest";
import { activeChapter, transitionChapter, chapterIssues, chapterSchema } from "../story/chapters.js";
import { computeActiveWorldbookIds } from "../lorebook/worldbook.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { worldDefinitionSchema } from "../world/schema.js";
import { createMockWorld, createMockGameState, createMockEntry } from "./test-utils.js";

const chapters = [
  { id: "origin", name: "Origin", greetingIds: ["g-origin"], nextChapterIds: ["holder"], conditions: [], conditionLogic: "all" as const },
  { id: "holder", name: "Holder", greetingIds: ["g-holder"], nextChapterIds: [], conditions: [{ variableId: "hp", operator: "gte" as const, value: 5 }], conditionLogic: "all" as const, transitionVariables: { year: 2280 }, timeline: "main", date: "2280", transitionText: "Three decades later." },
].map(value => chapterSchema.parse(value));
const world = () => createMockWorld({ chapters, variables: [
  { id: "hp", name: "HP", type: "number", defaultValue: 10 }, { id: "year", name: "Year", type: "number", defaultValue: 2250 },
], entries: [createMockEntry({ id: "g-origin", role: "greeting" }), createMockEntry({ id: "g-holder", role: "greeting", initialVariables: { hp: 100 } })] });

describe("native chapters", () => {
  it("infers starts from greetings and preserves explicit chapter through normalization and snapshots", () => {
    const sm = new GameStateManager(world(), createMockGameState({ activeGreetingId: "g-origin" }));
    expect(sm.getSnapshot().activeChapterId).toBe("origin");
    const next = transitionChapter(world(), sm.getSnapshot(), "holder");
    expect(new GameStateManager(world(), next).getSnapshot().activeChapterId).toBe("holder");
    expect(activeChapter(world(), next)?.id).toBe("holder");
    expect(next.activeGreetingId).toBe("g-origin");
  });
  it("preserves stats, persona, story and turn count; applies only explicit transition overrides", () => {
    const state = createMockGameState({ activeChapterId: "origin", activeGreetingId: "g-origin", variables: { hp: 7, year: 2250 }, turnCount: 9, metadata: { personaName: "Alex" } });
    const next = transitionChapter(world(), state, "holder");
    expect(next.variables).toEqual({ hp: 7, year: 2280 });
    expect(next.metadata.personaName).toBe("Alex"); expect(next.turnCount).toBe(9);
    expect(state.variables.year).toBe(2250);
  });
  it("rejects missing, forbidden, locked, disabled and completed transitions without modifying state", () => {
    const state = createMockGameState({ activeChapterId: "origin", variables: { hp: 2, year: 2250 } });
    expect(() => transitionChapter(world(), state, "holder")).toThrow(/conditions/i);
    expect(() => transitionChapter(world(), state, "missing")).toThrow();
    expect(() => transitionChapter(world(), { ...state, activeChapterId: "holder" }, "origin")).toThrow(/allowed/i);
    expect(() => transitionChapter({ ...world(), chapters: chapters.map(c => ({ ...c, enabled: false })) }, state, "holder")).toThrow();
    expect(() => transitionChapter(world(), { ...state, story: { status: "completed" } }, "holder")).toThrow(/completed/i);
    expect(state.variables.hp).toBe(2);
  });
  it("chapter-linked books follow the current chapter even after leaving their original greeting", () => {
    const books = [{ id: "past", name: "Past", order: 0, chapterIds: ["origin"], activation: { mode: "always" as const } },
      { id: "later", name: "Later", order: 1, chapterIds: ["holder"], activation: { mode: "greeting" as const, greetingIds: ["g-holder"] } },
      { id: "shared", name: "Shared", order: 2, activation: { mode: "always" as const } }];
    expect([...computeActiveWorldbookIds(books, createMockGameState({ activeChapterId: "holder", activeGreetingId: "g-origin" }))]).toEqual(["later", "shared"]);
    expect(computeActiveWorldbookIds([{ ...books[1]!, enabled: false }], createMockGameState({ activeChapterId: "holder" })).size).toBe(0);
  });
  it("validates links and keeps native definitions through schema roundtrip", () => {
    expect(chapterIssues(world())).toEqual([]);
    expect(worldDefinitionSchema.parse(world()).chapters).toHaveLength(2);
    const bad = { ...world(), chapters: [...chapters, { ...chapters[0]!, id: "duplicate" }] };
    expect(chapterIssues(bad).some(issue => issue.includes("g-origin"))).toBe(true);
    expect(chapterIssues({ ...world(), chapters: [{ ...chapters[0]!, nextChapterIds: ["missing"] }] }).length).toBeGreaterThan(0);
  });
});
