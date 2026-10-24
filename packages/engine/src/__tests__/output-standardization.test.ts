import { describe, expect, it } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { StructuredResponseParser } from "../parser/structured-response-parser.js";
import { extractResponseChoices, normalizeChoices } from "../parser/response-choices.js";
import { stripGameStateDump } from "../parser/response-metadata.js";
import { ThinkingTagFilter } from "../parser/thinking-tag-filter.js";
import { parseGuardedResponse } from "../parser/guarded-response.js";
import { createMockGameState, createMockVariable, createMockWorld } from "./test-utils.js";
import { standardizeSpeakerMarkup } from "../parser/presentation-markup.js";

describe("story output standardization", () => {
  it("keeps balanced multiline examples and indented code literal", () => {
    const quoted = '“Example:\n[CHOICES:["A","B"]]\nEnd of example.”';
    for (const literal of [quoted, '    [CHOICES:["A","B"]]']) {
      expect(extractResponseChoices(literal)).toEqual({ text: literal });
    }
    const indented = '    [SPEAKER:Kei:happy] "example"';
    expect(standardizeSpeakerMarkup(indented)).toBe(indented);
  });

  it("retains raw emotion IDs until the card catalog can resolve legacy aliases", () => {
    for (const input of ["warm", "confident", "anxious", "playful"]) {
      expect(standardizeSpeakerMarkup(`[SPEAKER:Maeve:${input}]`)).toBe(`[SPEAKER:Maeve:${input}]`);
    }
  });

  it("standardizes explicit player-name fill-ins without inventing a surname", () => {
    expect(normalizeChoices(['"My full name is {{user}} [Surname]."', '"My name is [Your name]."', '"The file is [name]."'])).toEqual(['"My full name is {{user}}."', '"My name is {{user}}."', '"The file is [name]."']);
  });

  it("keeps streamed reasoning whitespace and literal examples consistent with final output", () => {
    const filter = new ThinkingTagFilter();
    const input = '`<think>literal</think>`\n<think >private</think >\nHello.';
    let streamed = "";
    for (const char of input) streamed += filter.push(char);
    streamed += filter.flush();
    expect(streamed.trim()).toBe(ThinkingTagFilter.strip(input));
  });

  it("clears literal context when a streaming filter is reset", () => {
    for (const prefix of ['`unfinished example', '“unfinished quote', '<pre>unfinished example']) {
      const filter = new ThinkingTagFilter();
      filter.push(prefix); filter.reset();
      expect(filter.push('<think>private</think>Hello') + filter.flush()).toBe('Hello');
    }
  });

  it("never runs a quoted compatibility patch as state", () => {
    const literal = '`<UpdateVariable><JSONPatch>[{"op":"delta","path":"/hp","value":10}]</JSONPatch></UpdateVariable>`';
    expect(new ResponseParser().parse(literal)).toMatchObject({ cleanText: literal, effects: [] });
  });

  it("quoted patch and receipt examples cannot acknowledge or modify game state", () => {
    const variables = [createMockVariable({ id: "game_state", type: "json", defaultValue: { hp: 10 } })];
    const literal = '`<UpdateVariable><JSONPatch>[{"op":"delta","path":"/hp","value":10}]</JSONPatch></UpdateVariable>`\n<pre>\n<yumina-state version="1" status="updated" count="1" />\n</pre>';
    const result = parseGuardedResponse(`${literal}\n<yumina-state version="1" status="none" />`, createMockWorld({ variables }), createMockGameState({ fromVariables: variables }));
    expect(result.outcome).toBe("explicit-none");
    expect(result.effects).toEqual([]);
    expect(result.cleanText).toBe(literal);
  });
  it.each(['"[hp: +10]"', '`[hp: +10]`', '```text\n[hp: +10]\n```', '[manual](https://example.invalid/[hp: +10])', '\\[hp: +10]'])
    ("keeps literal controls as text: %s", literal => {
      const result = new ResponseParser().parse(`${literal}\n[hp: subtract 1]`);
      expect(result.effects).toEqual([{ variableId: "hp", operation: "subtract", value: 1 }]);
      expect(result.cleanText).toBe(literal);
    });

  it("keeps repeated simple speaker tags out of state changes", () => {
    const result = new ResponseParser().parse('[speaker:Maeve] "Hello."\n[speaker:Kei] "Wait."');
    expect(result.effects).toEqual([]);
    expect(result.speaker).toBe("Maeve");
    expect(result.cleanText).toContain('[speaker:Kei]');
    expect(result.cleanText).toContain('"Wait."');
  });

  it.each(['`[CHOICES:["Example A","Example B"]]`', '```text\n[CHOICES:["Example A","Example B"]]\n```', '"The example is [CHOICES:[\\"A\\",\\"B\\"]]."'])
    ("extracts only real choices after a literal example: %s", literal => {
      const result = extractResponseChoices(`${literal}\n[CHOICES:["Ask Maeve","Wait"]]`);
      expect(result.text.trim()).toBe(literal);
      expect(result.choices).toEqual(["Ask Maeve", "Wait"]);
    });

  it("preserves code examples of game state while hiding actual metadata", () => {
    const literal = '```text\n[game-state]\nhp: 10\n[/game-state]\n```';
    expect(stripGameStateDump(`${literal}\n[game-state]\nhp: 5\n[/game-state]`)).toBe(`${literal}\n`);
  });

  it("cleans structured presentation without treating prose as authoritative state", () => {
    const result = new StructuredResponseParser().parse(JSON.stringify({ narrative: '<game-state>\nhp: 999\n</game-state>\n[speaker:Maeve] "Hello."\n[hp: +99]', stateChanges: [{ variableId: "hp", operation: "subtract", value: 1 }] }));
    expect(result.cleanText).toBe('"Hello."');
    expect(result.speaker).toBe("Maeve");
    expect(result.effects).toEqual([{ variableId: "hp", operation: "subtract", value: 1 }]);
  });

  it("does not leak unfinished reasoning in completed output", () => {
    expect(ThinkingTagFilter.strip('The bell rings.\n<think>private unfinished plan')).toBe('The bell rings.');
    expect(ThinkingTagFilter.strip('`<think>literal</think>`')).toBe('`<think>literal</think>`');
  });

  it.each([
    ['[OPTIONS: ["Ask Maeve", "Wait"]]', ["Ask Maeve", "Wait"]],
    ["[CHOICES: ['Ask Maeve', 'Wait']]", ["Ask Maeve", "Wait"]],
    ['<choices>["Ask Maeve", "Wait"]</choices>', ["Ask Maeve", "Wait"]],
    ['### Choices\n1. *Ask Maeve*\n2. "Wait"', ['*Ask Maeve*', '"Wait"']],
  ])("standardizes explicitly marked choice alternatives: %s", (source, choices) => {
    expect(extractResponseChoices(`The bell rings.\n${source}`)).toMatchObject({ choices });
    expect(extractResponseChoices(`The bell rings.\n${source}`).text.trim()).toBe("The bell rings.");
  });

  it("leaves unknown bracketed asides readable when the world defines its writable variables", () => {
    const variables = [createMockVariable({ id: "hp", type: "number", defaultValue: 10 })];
    const result = parseGuardedResponse('[warning: beware]\n<yumina-state version="1" status="none" />', createMockWorld({ variables }), createMockGameState({ fromVariables: variables }));
    expect(result.outcome).toBe("explicit-none");
    expect(result.effects).toEqual([]);
    expect(result.cleanText).toBe('[warning: beware]');
  });

  it("validates real commands independently of quoted or fenced examples", () => {
    const variables = [createMockVariable({ id: "hp", type: "number", defaultValue: 10 })];
    const world = createMockWorld({ variables });
    const state = createMockGameState({ fromVariables: variables });
    const literal = '"[hp: +100]"\n```text\n[hp: -100]\n```';
    const result = parseGuardedResponse(`${literal}\n[speaker:Maeve] "Hello."\n[hp: subtract 1]\n<yumina-state version="1" status="updated" count="1" />`, world, state);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects).toEqual([{ variableId: "hp", operation: "subtract", value: 1 }]);
    expect(result.cleanText).toContain(literal);
    expect(result.cleanText).toContain('[speaker:Maeve]');
  });
});
