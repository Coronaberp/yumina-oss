import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendPersonaSystemMessage,
  buildPersonaSystemMessage,
  type PersonaPromptMessage,
} from "./persona-prompt.js";

describe("buildPersonaSystemMessage", () => {
  it('applies explicit session control even when no descriptive persona is selected', () => {
    const messages: PersonaPromptMessage[] = [];
    appendPersonaSystemMessage(messages, null, 'ai');
    assert.match(messages[0]?.content ?? '', /AI controlled/);
  });
  it("uses personality as descriptive context under explicit AI control without contradictory manual rules", () => {
    const prompt = buildPersonaSystemMessage({ name: 'Robin', personality: 'Reserved and stubborn' }, undefined, 'ai');
    assert.match(prompt ?? '', /AI controlled/);
    assert.match(prompt ?? '', /Reserved and stubborn/);
    assert.match(prompt ?? '', /World rules and the current game-state stats are authoritative/);
    assert.doesNotMatch(prompt ?? '', /NEVER write the persona|Never emit \[SPEAKER/);
  });
  it("explicitly binds a name-only persona as the user's spoken name", () => {
    const prompt = buildPersonaSystemMessage({ name: "Alex" });

    assert.ok(prompt?.includes("User's roleplay name: {{user}}"));
    assert.ok(!prompt?.includes("Alex"));
  });

  it("does not require descriptive persona fields before injecting the name", () => {
    const prompt = buildPersonaSystemMessage({ name: "Alex" });

    assert.ok(prompt?.includes("User's roleplay name: {{user}}"));
    assert.doesNotMatch(prompt ?? "", /use this exact name/i);
    assert.doesNotMatch(prompt ?? "", /Appearance:/);
  });

  it("includes optional persona details after the name binding", () => {
    const prompt = buildPersonaSystemMessage({
      name: "Alex",
      appearance: "silver hair",
      personality: "reserved",
      backstory: "from the old city",
    });

    assert.match(prompt ?? "", /\[User Persona\]/);
    assert.ok(prompt?.includes("User's roleplay name: {{user}}"));
    assert.ok(prompt?.includes("Appearance: silver hair"));
    assert.ok(prompt?.includes("Personality: reserved"));
    assert.ok(prompt?.includes("Backstory: from the old city"));
  });

  it("adds nothing at all to the outgoing prompt when personas are disabled", () => {
    const messages: PersonaPromptMessage[] = [
      { role: "system", content: "World rules only." },
      { role: "user", content: "Continue the story." },
    ];

    appendPersonaSystemMessage(messages, null);

    assert.deepEqual(messages, [
      { role: "system", content: "World rules only." },
      { role: "user", content: "Continue the story." },
    ]);
    assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /persona/i);
  });
});
