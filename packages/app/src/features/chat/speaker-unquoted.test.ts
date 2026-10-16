import assert from "node:assert/strict";
import test from "node:test";
import { splitSpeakerSections } from "../../../sandbox/chat/speaker";

const characters = [{ name: "Mei Amery", role: "character" }, { name: "Blair Winters", role: "character" }];

test("the CODE opening separates unquoted Mei speech from italic attributions without portraits", () => {
  const text = "*The girl turned around.*\n\nNervous? *Mei says softly* to be honest with you…so am I…I mean who wouldn't in this situation. I'm Mei. Mei Amery. *Mei says softly.* let's both pray that we get some strong ones. *Mei says jokingly.*\n\n*Soon it was Mei's turn.*\n\nWish me luck~ *Mei says nervously as Mei stepped into the center.*";
  const sections = splitSpeakerSections(characters, text);
  assert.deepEqual(sections.map(section => section.speaker?.name ?? "Narrator"), ["Narrator", "Mei Amery", "Narrator", "Mei Amery", "Narrator", "Mei Amery", "Narrator", "Mei Amery", "Narrator"]);
  const spoken = sections.filter(section => section.speaker);
  assert.ok(spoken[0]!.content.includes("Nervous?"));
  assert.ok(spoken.at(-1)!.content.includes("Wish me luck~"));
  assert.ok(spoken.every(section => !section.content.includes("says") && section.speaker?.portrait === null));
  assert.equal(sections.map(section => section.text).join(""), text);
  assert.equal(sections.map(section => section.content).join(""), text);
});

test("unquoted attribution does not cross paragraphs, invent speakers or claim ordinary narration", () => {
  for (const text of [
    "Mei's turn was next.\n\n*Mei says softly.*",
    "The hall is quiet. *Mei looks at Blair.*",
    "The hall is quiet. *Mei and Blair say together.*",
    "Mei waits.\n\nThe room falls quiet.",
    "Narrator: Nervous? *Mei says softly.*",
    "```text\nNervous? *Mei says softly.*\n```",
    "    Nervous? *Mei says softly.*",
  ]) {
    const sections = splitSpeakerSections(characters, text);
    assert.ok(sections.every(section => section.speaker === null), text);
    assert.equal(sections.map(section => section.text).join(""), text);
  }
  const ambiguous = [{ name: "Mei Amery", role: "character" }, { name: "Mei Other", role: "character" }];
  const sections = splitSpeakerSections(ambiguous, "Nervous? *Mei says softly.*");
  assert.ok(sections.every(section => !section.speaker || section.speaker.name === "NPC"));
});

test("conflicting adjacent unquoted speakers do not guess ownership", () => {
  const text = "*Mei says softly.* Hello. Hi. *Blair replies.*";
  const sections = splitSpeakerSections(characters, text);
  assert.ok(sections.every(section => section.speaker === null));
  assert.equal(sections.map(section => section.text).join(""), text);
});

test("bold-wrapped quoted announcements are speech while italic descriptions remain narration", () => {
  const text = '**"CANDIDATE ACKNOWLEDGED."** *Says the Black Garden in its robotic and flat tone.* **"EVALUATING…"**\n\n*There was silence.*\n\n**"CODE ASSIGNED: UNIQUE-TYPE. STABLE."**';
  const sections = splitSpeakerSections(characters, text);
  assert.deepEqual(sections.map(section => section.speaker?.name ?? "Narrator"), ["NPC", "Narrator", "NPC", "Narrator", "NPC"]);
  assert.equal(sections.map(section => section.text).join(""), text);
  assert.ok(sections.filter(section => section.speaker).every(section => !section.content.includes("robotic")));
  assert.ok(sections[0]!.content.includes('**"CANDIDATE ACKNOWLEDGED."**'), "Spoken emphasis reaches the Markdown renderer");
  for (const description of ['*The "Basic" holders wait.*', '**The "Basic" holders wait.**', '*Mei mouthed "Good Luck~".*']) {
    assert.ok(splitSpeakerSections(characters, description).every(section => !section.speaker));
  }
});

test("legacy Markdown-escaped quotes in the actual opening still separate dialogue", () => {
  const text = String.raw`**\"CANDIDATE ACKNOWLEDGED.\"** *Says the Black Garden in its robotic and flat tone.* **\"EVALUATING…\"**`;
  const sections = splitSpeakerSections(characters, text);
  assert.deepEqual(sections.map(section => section.speaker?.name ?? "Narrator"), ["NPC", "Narrator", "NPC"]);
  assert.equal(sections.map(section => section.text).join(""), text);
  const plain = String.raw`\"Doesn't matter what the Garden gives me,\" *the boy mutters.* \"I already have a Unique lined up.\"`;
  const boy = splitSpeakerSections(characters, plain);
  assert.deepEqual(boy.map(section => section.speaker?.name ?? "Narrator"), ["NPC", "Narrator", "NPC"]);
  assert.equal(boy.map(section => section.text).join(""), plain);
  const code = '```text\n' + plain + '\n```';
  assert.ok(splitSpeakerSections(characters, code).every(section => section.speaker === null));
  const possessives = String.raw`{{user}}\'s gaze met {{char}}\'s eyes. The Adventurers\' Guild waited.`;
  const narration = splitSpeakerSections(characters, possessives);
  assert.ok(narration.every(section => section.speaker === null));
  assert.equal(narration.map(section => section.text).join(""), possessives);
});
