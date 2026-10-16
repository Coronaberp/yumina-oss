import assert from "node:assert/strict";
import test from "node:test";
import { splitSpeakerSections } from "../../../sandbox/chat/speaker";

const entries = [
  { name: "Mei Amery", role: "character", portrait: "/cdn/mei" },
  { name: "Blair Winters", role: "character" },
  { name: "Player", role: "character", player: true, playerName: "Aelorian Myrren (You)" },
];

test("Chat reads the engine's per-passage speaker markers and consumes emotion separately", () => {
  const text = '[SPEAKER:Narrator:normal] *The hall opens.*\n[SPEAKER:Mei Amery:happy] "Hello."\n[Name:Blair:irritated] "Wait."\n[SPEAKER:Narrator:smug] *The bell rings.*';
  const sections = splitSpeakerSections(entries, text);
  assert.deepEqual(sections.map(section => section.speaker?.name || "Narrator"), ["Narrator", "Mei Amery", "Blair Winters", "Narrator"]);
  assert.deepEqual(sections.map(section => section.emotion), ["normal", "happy", "angry", "normal"]);
  assert.equal(sections[1]!.speaker?.portrait, "/cdn/mei");
  assert.equal(sections[2]!.speaker?.portrait, null);
  assert.ok(sections.every(section => !/\[(?:SPEAKER|Name):/i.test(section.content)));
  assert.equal(sections.map(section => section.text).join(""), text);
});

test("a canonical marker owns successive paragraphs until the next marker; italic actions stay narrator", () => {
  const text = '[SPEAKER:Mei:happy] Hello.\n\nWelcome to the academy.\n\n*Blair steps back.*\n\n"Stay here," Blair says.\n[SPEAKER:Narrator:normal] "The announcement ends."';
  const sections = splitSpeakerSections(entries, text);
  assert.deepEqual(sections.map(section => section.speaker?.name || "Narrator"), ["Mei Amery", "Narrator", "Mei Amery", "Narrator"]);
  assert.ok(sections[0]!.content.includes("Welcome to the academy."));
  assert.ok(sections[1]!.content.includes("Blair steps back"));
  assert.equal(sections.map(section => section.text).join(""), text);
});

test("unknown speakers are NPC without a borrowed portrait; NPC identity stays hidden metadata", () => {
  const text = '[SPEAKER:Unknown Clerk:normal] "Next."\n[SPEAKER:NPC:amused:female:academy-clerk] "Welcome."\n[SPEAKER:Blair Winters:surprised] "Oh."';
  const sections = splitSpeakerSections(entries, text);
  assert.deepEqual(sections.map(section => section.speaker), [{ name: "NPC", portrait: null }, { name: "NPC", portrait: null }, { name: "Blair Winters", portrait: null }]);
  assert.equal(sections[1]!.emotion, "happy");
  assert.equal(sections[1]!.npcGender, "female");
  assert.equal(sections[1]!.npcId, "academy-clerk");
  assert.ok(!sections[1]!.content.includes("academy-clerk"));
  assert.equal(sections[2]!.emotion, "normal");
  assert.equal(splitSpeakerSections([{ ...entries[0]!, enabled: false }], '[SPEAKER:Mei Amery:happy] "Hi."')[0]!.speaker?.name, "NPC");
});

test("markers inside code, quotes, links and escaped examples remain literal", () => {
  const text = '[SPEAKER:Mei:normal] "The literal marker is [SPEAKER:Blair:angry]."\n\n`[SPEAKER:Blair:angry]`\n\n```text\n[SPEAKER:Blair:angry]\n```\n\n[guide](https://example.invalid/[SPEAKER:Blair:angry])\n\\[SPEAKER:Blair:angry]\n[SPEAKER:Blair:happy] "Real speech."';
  const sections = splitSpeakerSections(entries, text);
  assert.equal(sections.filter(section => section.speaker?.name === "Blair Winters").length, 1);
  assert.ok(sections.some(section => section.content.includes('literal marker is [SPEAKER:Blair:angry]')));
  assert.ok(sections.some(section => section.content.includes('```text\n[SPEAKER:Blair:angry]\n```')));
  assert.equal(sections.map(section => section.text).join(""), text);
});

test("player markers resolve the persona without altering raw text or exposing provider prose", () => {
  const text = '[SPEAKER:Player:normal] "Ready."';
  const section = splitSpeakerSections(entries, text)[0]!;
  assert.equal(section.speaker?.name, "Aelorian Myrren (You)");
  assert.equal(section.text, text);
  const clean = splitSpeakerSections(entries, '"Hello."', '[SPEAKER:Mei:happy] Unprocessed private source. [gold: +99]');
  assert.equal(clean[0]!.speaker?.name, "Mei Amery");
  assert.equal(clean[0]!.content, '"Hello."');
});

test("scene markers and consecutive empty speaker markers do not leak or create empty bubbles", () => {
  const text = '[SCENE:courtyard][SPEAKER:Mei:happy][SPEAKER:Blair:normal] "Hello."';
  const sections = splitSpeakerSections(entries, text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.speaker?.name, "Blair Winters");
  assert.equal(sections[0]!.scene, "courtyard");
  assert.equal(sections[0]!.content, ' "Hello."');
  assert.equal(sections[0]!.text, text);
});

test("later streaming marker fragments stay hidden until complete without erasing prior speech", () => {
  for (const tail of ["[", "[S", "[SPEAK", "[SPEAKER:", "[SPEAKER:Blair:", "[SPEAKER:Blair:happ"]) {
    const sections = splitSpeakerSections(entries, '[SPEAKER:Mei:happy] "Hello."\n' + tail, undefined, { streaming: true });
    assert.equal(sections[0]?.speaker?.name, "Mei Amery");
    assert.equal(sections.map(section => section.content).join("").trim(), '"Hello."', tail);
  }
});
