import { describe, expect, it } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { StructuredResponseParser } from "../parser/structured-response-parser.js";
import { buildSpeakerFormatBlock, parseLeadingSpeakerTag } from "../prompts/speaker-tag.js";
import { parseGuardedResponse } from "../parser/guarded-response.js";
import { createMockWorld, createMockVariable, createMockGameState } from "./test-utils.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { stripZeroWidthSpaces } from "../parser/text-normalization.js";

describe("VN response protocol", () => {
  it("removes zero-width spaces throughout story text, including prose and choices", () => {
    const raw = '[\u200BSPEAKER:Miveth:happy] "Hel\u200Blo."\n[\u200BCHOICES: ["Ask\u200B again", "Wait"]]';
    const parsed = new ResponseParser().parse(raw);
    expect(parsed.cleanText).toBe('[SPEAKER:Miveth:happy] "Hello."');
    expect(parsed.choices).toEqual(["Ask again", "Wait"]);
    const guarded = parseGuardedResponse(raw, createMockWorld({ variables: [] }), createMockGameState());
    expect(guarded.cleanText).not.toContain("\u200B");
    expect(guarded.choices).toEqual(["Ask again", "Wait"]);
    expect(new StructuredResponseParser().parse(JSON.stringify({ narrative: "Hel\u200Blo.", choices: ["Ask\u200B again"] }))).toMatchObject({ cleanText: "Hello.", choices: ["Ask again"] });
    expect(parseGuardedResponse('{"narrative":"Hel\\u200Blo.","stateChanges":', createMockWorld({ variables: [] }), createMockGameState()).cleanText).toBe("Hello.");
    expect(stripZeroWidthSpaces("A\u200CB\u200DC\u200BD")).toBe("A\u200CB\u200DCD");
  });
  it("selecting VN requires speaker markers without portrait or author-entry prerequisites", () => {
    const world = createMockWorld({ rootComponent: { id: "root", name: "VN", interfaceId: "vn", entryFile: "index.tsx", files: { "index.tsx": "code" }, updatedAt: "now" }, entries: [
      { id: "e", name: "Evelia", role: "character", enabled: true, content: "" } as any,
    ] });
    expect(buildSpeakerFormatBlock(world)).toContain("[SPEAKER:Name:emotion]");
    const reminder = new PromptBuilder().buildPostHistoryEntries(world, createMockGameState()).at(-1);
    expect(reminder?.apiRole).toBe("system");
    expect(reminder?.content).toContain("EVERY spoken passage");
    expect(reminder?.content).toContain("Evelia");
    expect(reminder?.content).toContain("pronoun");
    expect(reminder?.content).toContain("ALL narrator actions and descriptions");
    expect(reminder?.content).toContain("his/her/their");
    expect(buildSpeakerFormatBlock(world)).toContain("named possessives");
    expect(reminder?.content).toContain("literal token {{user}}");
    expect(reminder?.content).toContain("Use named-character grammar");
    expect(reminder?.content).toContain("[SPEAKER:NPC:emotion]");
    expect(buildSpeakerFormatBlock(world)).toContain("[SPEAKER:NPC:emotion]");
    expect(reminder?.content).toContain("[SPEAKER:NPC:emotion:male:stable-id]");
    expect(buildSpeakerFormatBlock(world)).toContain("[SPEAKER:NPC:emotion:female:stable-id]");
    expect(reminder?.content).toContain("Never infer gender from a name alone");
    for (const prompt of [buildSpeakerFormatBlock(world), reminder?.content]) {
      expect(prompt).toContain("ONLY one of these six sprite expressions: normal, happy, sad, angry, shy, smug");
      expect(prompt).toContain("Use angry for irritated");
      expect(prompt).toContain("Narrator always uses normal");
    }
  });
  it("choices request italic actions and quoted proposed dialogue", () => {
    const world = createMockWorld({ rootComponent: { id: "root", name: "VN", interfaceId: "vn", entryFile: "index.tsx", files: { "index.tsx": "code" }, updatedAt: "now" } });
    const reminder = new PromptBuilder().buildPostHistoryEntries(world, createMockGameState()).at(-1);
    for (const prompt of [buildSpeakerFormatBlock(world), reminder?.content]) {
      expect(prompt).toContain("Wrap choice actions in single asterisks");
      expect(prompt).toContain('dialogue in double quotes');
      expect(prompt).toContain('Escape dialogue quotes');
    }
  });
  it("keeps VN presentation metadata outside the strict state guard command count", () => {
    const variables = [createMockVariable({ id: "health", name: "health", defaultValue: 100 })];
    const result = parseGuardedResponse('[SPEAKER:Miveth:happy] "Hello."\n[health: subtract 1]\n[CHOICES: ["A", "B"]]\n<yumina-state version="1" status="updated" count="1" />', createMockWorld({ variables }), createMockGameState({ fromVariables: variables }));
    expect(result.outcome).toBe("valid-updates");
    expect(result.choices).toEqual(["A", "B"]);
    expect(result.cleanText).toContain("[SPEAKER:Miveth:happy]");
    expect(result.effects).toHaveLength(1);
  });
  it("preserves speakers, expressions and scenes and extracts actual choices without state writes", () => {
    const result = new ResponseParser().parse('[SCENE:gardens]\n[SPEAKER:Miveth:happy] "Hello."\n*Evelia steps back.*\n[Name:Evelia:shy] "Wait."\n[CHOICES: ["Say \\"hello\\"", "Stay [here]", "Stay [here]"]]\n[rel-miveth: +1]');
    expect(result.cleanText).toContain('[SPEAKER:Miveth:happy]');
    expect(result.cleanText).toContain('[SPEAKER:Evelia:shy]');
    expect(result.cleanText).toContain('[SCENE:gardens]');
    expect(result.cleanText).not.toContain("CHOICES");
    expect(result.choices).toEqual(['Say "hello"', "Stay [here]"]);
    expect(result.effects).toEqual([{ variableId: "rel-miveth", operation: "add", value: 1 }]);
  });
  it("does not mistake a three-field VN marker for the chat speaker tag", () => {
    expect(parseLeadingSpeakerTag('[SPEAKER:Miveth:happy] "Hello."').speaker).toBeNull();
    expect(parseLeadingSpeakerTag('[speaker: Miveth] Hello.').speaker).toBe("Miveth");
  });
  it("keeps NPC gender and identity as presentation metadata, without state effects", () => {
    const content = '[SPEAKER:NPC:normal:male:academy-clerk] "Name?" [SPEAKER:NPC:happy:female:merchant] "Welcome."';
    const result = new ResponseParser().parse(content);
    expect(result.cleanText).toBe(content);
    expect(result.effects).toEqual([]);
    expect(parseLeadingSpeakerTag(content).speaker).toBeNull();
  });
  it("supports structured choices and leaves an authored choices variable directive alone", () => {
    expect(new StructuredResponseParser().parse(JSON.stringify({ narrative: "Hi", choices: ["A", "B"] })).choices).toEqual(["A", "B"]);
    expect(new ResponseParser().parse('[choices: set "custom"]')).toMatchObject({ effects: [{ variableId: "choices", operation: "set", value: "custom" }] });
  });
  it("recovers the observed CHOCIES typo without turning choices into speech or state writes", () => {
    const raw = '*The crowd watches.*\n[CHOCIES: ["Step forward", "Help the boy"]]\n[SPEAKER:NPC:smug:male:noble] "Wait."';
    const parsed = new ResponseParser().parse(raw);
    expect(parsed.choices).toEqual(["Step forward", "Help the boy"]);
    expect(parsed.cleanText).toContain('*The crowd watches.*');
    expect(parsed.cleanText).toContain('[SPEAKER:NPC:smug:male:noble] "Wait."');
    expect(parsed.cleanText).not.toContain("CHOCIES");
    expect(parsed.effects).toEqual([]);
  });
  it("extracts valid choices with invisible marker padding without changing story or state", () => {
    for (const padding of ["\u200B", "\u2060"]) for (const keyword of ["CHOICES", "CHOCIES"]) {
      const raw = `*The lesson continues.*\n[${padding}${keyword}: ["Hold steady", "Ask about the experiment", "Step back"]]\n[health: -1]`;
      const parsed = new ResponseParser().parse(raw);
      expect(parsed.choices).toEqual(["Hold steady", "Ask about the experiment", "Step back"]);
      expect(parsed.cleanText.trim()).toBe("*The lesson continues.*");
      expect(parsed.effects).toEqual([{ variableId: "health", operation: "subtract", value: 1 }]);
    }
  });
  it("hides a state dump with mixed wrappers while preserving following story and directives", () => {
    const raw = '*The clerk nods.*\n[game-state]\nacademy-day: 1\nplayer-wealth: 90\n</game-state>\n[SPEAKER:NPC:normal] "Next."\n[health: -1]';
    const parsed = new ResponseParser().parse(raw);
    expect(parsed.cleanText).not.toContain("game-state");
    expect(parsed.cleanText).not.toContain("player-wealth");
    expect(parsed.cleanText).toContain('"Next."');
    expect(parsed.effects).toEqual([{ variableId: "health", operation: "subtract", value: 1 }]);
  });
  it("uses the authored VN format without the once-only chat override, and requires named attribution", () => {
    const world: any = { variables: [], entries: [
      { name: "Miveth", role: "character", portrait: "@asset:m" },
      { name: "Evelia", role: "character", portrait: "@asset:e" },
      { role: "style", content: "VN MARKERS: [SPEAKER:Miveth:emotion]" },
    ] };
    const prompt = buildSpeakerFormatBlock(world);
    expect(prompt).toContain("[SPEAKER:Name:emotion]");
    expect(prompt).toContain("[CHOICES:");
    expect(prompt).toContain('Never use "she says", "he says", or "they say"');
    expect(prompt).not.toContain("[speaker: Name]");
    expect(prompt).not.toContain("only once");
  });
});
