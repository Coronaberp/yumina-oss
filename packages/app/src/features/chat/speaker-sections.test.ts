import assert from "node:assert/strict";
import test from "node:test";
import * as speaker from "../../../sandbox/chat/speaker";

const evelia = { name: "Evelia", role: "character", portrait: "/cdn/evelia" };
const miveth = { name: "NPC: Miveth", role: "character", portrait: "/cdn/miveth" };
const entries = [evelia, miveth];

function split(text: string, raw = text, characters: speaker.SpeakerEntry[] = entries) {
  assert.equal(typeof speaker.splitSpeakerSections, "function", "chat needs per-section speaker resolution");
  return speaker.splitSpeakerSections(characters, text, raw);
}

test("older mixed prose separates narrated actions from each character's speech", () => {
  const text = '*The room catches your attention.*\n\n*Evelia’s tail flicks once.* "Would you like wine?"\n\n*Miveth remains in the doorway.* "The air is sour."';
  const sections = split(text, `[speaker: narrator]\n${text}`);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia", "Narrator", "Miveth"]);
  assert.deepEqual(sections.map(s => s.speaker?.portrait ?? null), [null, "/cdn/evelia", null, "/cdn/miveth"]);
  assert.ok(sections.filter(s => s.speaker).every(s => !s.content.includes("tail flicks") && !s.content.includes("remains")));
  assert.equal(sections.map(s => s.text).join(""), text);
  assert.equal(sections.map(s => s.content).join(""), text);
});

test("explicit speaker labels split adjacent lines and are hidden from rendered prose", () => {
  const text = 'Narrator: The door opens.\nEvelia: "Come inside."\n**Miveth**: "Wait."\nNarrator: The candles flicker.';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia", "Miveth", "Narrator"]);
  assert.equal(sections.map(s => s.text).join(""), text);
  assert.deepEqual(sections.map(s => s.content.trim()), ['The door opens.', '"Come inside."', '"Wait."', 'The candles flicker.']);
});

test("unattributed dialogue uses NPC while mentions stay with the narrator", () => {
  const text = 'The room reminds Evelia of home.\n\n"Someone should close the door."\n\nThe player looks at Miveth.';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "NPC", "Narrator"]);
  assert.ok(sections.every(s => !s.speaker?.portrait));
  assert.equal(sections.map(s => s.content).join(""), text);
});

test("Classic resolves unique short names without changing canonical names or crossing paragraphs", () => {
  const diane = { name: "Diane (Bluerose)", role: "character", portrait: "/cdn/diane" };
  for (const text of ['*Diane says* "Hmph."', '"Hmph," says Diane.', 'Diane: "Hmph."', '[speaker: Diane]\n"Hmph."']) {
    const sections = split(text, text, [...entries, diane]);
    assert.ok(sections.some(section => section.speaker?.name === diane.name));
    assert.ok(sections.filter(section => section.speaker).every(section => section.speaker?.name === diane.name && section.speaker.portrait === diane.portrait));
    assert.equal(sections.map(section => section.content).join(""), text.replace(/^Diane: /, "").replace(/^\[speaker: Diane\]\n/, ""));
  }
  const text = '"Next. Name. Now."\n\n*Diane says* "Hmph, stupid peasants blocking my path."';
  const sections = split(text, text, [...entries, diane]);
  assert.deepEqual(sections.map(section => section.speaker?.name || "Narrator"), ["NPC", "Narrator", diane.name]);
  assert.equal(sections[0].speaker?.portrait, null);
  assert.equal(sections.map(section => section.content).join(""), text);
  const collision = split('*Diane says* "Hmph."', undefined, [diane, { ...diane, name: "Diane (Redrose)" }]);
  assert.equal(collision.at(-1)?.speaker?.name, "NPC");
  assert.ok(collision.every(section => !section.speaker?.portrait));
});

test("Classic labels undefined speakers NPC with no portrait and preserves explicit narration", () => {
  assert.deepEqual(split('"Hello."', undefined, [])[0].speaker, { name: "NPC", portrait: null });
  assert.deepEqual(split('[speaker: Clerk]\nWelcome.', undefined, [])[0].speaker, { name: "NPC", portrait: null });
  assert.deepEqual(split('NPC: Welcome.', undefined, [])[0].speaker, { name: "NPC", portrait: null });
  assert.equal(split('Narrator: "The hall is quiet."', undefined, [])[0].speaker, null);
  assert.equal(split('[speaker: narrator]\n"The hall is quiet."', undefined, [])[0].speaker, null);
  assert.equal(split('*The hall is quiet.*', undefined, [])[0].speaker, null);
});

test("Classic matches arbitrary defined names and rejects ambiguous name parts", () => {
  for (const [name, alias] of [["Sera (Seraphine)", "Seraphine"], ["Ryu (Ryutharax)", "Ryu"], ["Lilith Vexthorne", "Lilith"], ["Diane Bluerose", "Diane"], ["阿璃 (Ari)", "阿璃"], ["A+B Scholar", "A+B"]]) {
    const character = { name, role: "character", portrait: "/cdn/defined-character" };
    const sections = split(`*${alias} says* "Welcome."`, undefined, [...entries, character]);
    assert.deepEqual(sections.at(-1)?.speaker, { name, portrait: character.portrait });
  }
  const ambiguous = split('*Diane says* "Welcome."', undefined, [{ name: "Diane Bluerose", role: "character" }, { name: "Diane Redrose", role: "character" }]);
  assert.deepEqual(ambiguous.at(-1)?.speaker, { name: "NPC", portrait: null });
});

test("name prefixes do not confuse shorter names or disabled characters", () => {
  const mia = { ...evelia, name: "Mia" };
  const miabelle = { ...miveth, name: "Miabelle" };
  const text = '*Miabelle smiles.* "Hello."\n\nMiasma fills the room.\n\nMiveth: Hello.';
  const sections = split(text, text, [mia, miabelle, { ...miveth, enabled: false }]);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Miabelle", "Narrator"]);
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("characters without portraits still have a speaker label", () => {
  const sections = split("Evelia: Hello.\n\nMiveth: Hi.", undefined, [evelia, { ...miveth, portrait: null }]);
  assert.deepEqual(sections.map(s => s.speaker), [{ name: "Evelia", portrait: "/cdn/evelia" }, { name: "Miveth", portrait: null }]);
});

test("a legacy single speaker tag attributes the first section without rendering raw output", () => {
  const text = '"Hello."\n\nEvelia: Hello.';
  const sections = split(text, `[speaker: Miveth]\nUnprocessed private source. [gold: +1]`);
  assert.deepEqual(sections.map(s => s.speaker?.name), ["Miveth", "Evelia"]);
  assert.equal(sections.map(s => s.text).join(""), text);
  assert.ok(!sections.some(s => s.content.includes("Unprocessed")));
});

test("single-character speech has a portrait while italic actions remain narrator", () => {
  const text = '*The sun sets.* "Hello."\n\n*She waits by the window.* "Stay."';
  const sections = split(text, text, [evelia]);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia", "Narrator", "Evelia"]);
  assert.equal(sections.map(s => s.content).join(""), text);
  assert.equal(split("Narrator: The sun sets.", undefined, [evelia])[0].speaker, null);
});

test("blank lines and speaker-like text inside fenced code stay intact", () => {
  const text = 'Evelia: A note.\n\n```text\nMiveth: This is code.\n\nNarrator: Still code.\n```\n\nMiveth: I see.';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Evelia", "Narrator", "Miveth"]);
  assert.ok(sections[1].content.includes('```text\nMiveth: This is code.\n\nNarrator: Still code.\n```'));
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("nested-length code fences do not end at shorter embedded fences", () => {
  const text = "````markdown\n```\n\nMiveth: Example.\n```\n````\n\nEvelia: Outside.";
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia"]);
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("raw HTML containers stay whole instead of breaking markup at paragraph boundaries", () => {
  const text = '<div>\nEvelia: Example.\n\nMiveth: Example.\n</div>';
  const sections = split(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].content, text);
});

test("same-speaker paragraphs merge while preserving markdown images and choices", () => {
  const text = '*Evelia smiles.*\n\nEvelia: **Hello.** ![wine](@asset:abc)\n\nMiveth: [Stay](choice:Stay)';
  const sections = split(text);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].speaker, null);
  assert.equal(sections[1].speaker?.name, "Evelia");
  assert.ok(sections[1].content.includes('**Hello.** ![wine](@asset:abc)'));
  assert.ok(sections[2].content.includes('[Stay](choice:Stay)'));
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("empty streaming content creates no phantom section", () => {
  assert.deepEqual(split("", "[spea"), []);
});

test("imported history with a leading speaker tag hides that metadata", () => {
  const sections = split("[speaker: Evelia]\nEvelia: Hello.\n\nMiveth: Hi.");
  assert.deepEqual(sections.map(s => s.speaker?.name), ["Evelia", "Miveth"]);
  assert.equal(sections.map(s => s.content).join(""), "Hello.\n\nHi.");
});

test("emphasized names at the paragraph start identify their character", () => {
  const sections = split('**Evelia** turns around. "Hello."\n\n_Miveth_ nods. "Hi."');
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia", "Narrator", "Miveth"]);
});

test("blockquotes, lists, and indented code are not mistaken for speaker labels", () => {
  const text = '> Evelia: Quoted example.\n>\n> Miveth: Still quoted.\n\n- Evelia: A list item.\n\n- Miveth: Another item.\n\n    Miveth: Indented example.';
  const sections = split(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].speaker, null);
  assert.equal(sections[0].content, text);
});

test("the screenshot's quoted Miveth dialogue uses her portrait while actions stay narrator", () => {
  const text = '*The two girls remain frozen. Evelia stands by the table.*\n\n*Miveth has not moved from the threshold.*\n\n"Is it... the wine?" *Miveth asks, so quietly it might be herself she’s speaking to. She looks between the table and Evelia.* "I should not be here."\n\n*Evelia lets out a breath.* "It’s just a private dinner, Princess Miveth."';
  const sections = split(text, `[speaker: narrator]\n${text}`);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Miveth", "Narrator", "Miveth", "Narrator", "Evelia"]);
  assert.ok(sections[1].content.includes('"Is it... the wine?"'));
  assert.equal(sections.map(s => s.text).join(""), text);
  assert.equal(sections.map(s => s.content).join(""), text);
});

test("quoted dialogue recognizes speech attributions with straight and smart quotes", () => {
  for (const text of [
    '"Stay with me," *Miveth asks quietly.*',
    '“Stay with me,” **Miveth** whispers.',
    '‘Stay with me,’ _Miveth murmured._',
    '"Stay with me," asks Miveth.',
    "'Don’t leave,' Miveth asks.",
    '"Stay with me." — *Miveth said.*',
    '"Tell Evelia I’m here," Miveth replies.',
    '"Stay \\"with me\\", please," Miveth asks.',
  ]) {
    const sections = split(text);
    assert.equal(sections[0].speaker?.name, "Miveth", text);
    assert.equal(sections.map(s => s.content).join(""), text);
    assert.ok(sections.slice(1).every(s => s.speaker === null));
  }
});

test("names mentioned inside dialogue or unrelated actions do not select a portrait", () => {
  for (const text of [
    '"Miveth is in the hall." Evelia looks toward the door.',
    '"Miveth asks about wine." The room falls quiet.',
    '"Is it wine?" Miveth looks between the table and Evelia.',
    '"Is it wine?" Princess Miveth watches Evelia.',
    '"Is it wine?" Miveth and Evelia ask together.',
    '"Miveth asks about wine.',
    '"Hello," Mi says.',
  ]) {
    const sections = split(text);
    assert.deepEqual(sections[0].speaker, { name: "NPC", portrait: null }, text);
    assert.equal(sections.map(s => s.content).join(""), text);
  }
});

test("explicit labels remain authoritative for quoted dialogue", () => {
  const text = 'Narrator: "It’s wine," Miveth says.\n\nEvelia: "Miveth asks about wine."';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Evelia"]);
});

test("disabled and similarly named characters cannot claim a quoted attribution", () => {
  const text = '"Hello," Miveth asks.';
  assert.deepEqual(split(text, text, [evelia, { ...miveth, enabled: false }])[0].speaker, { name: "NPC", portrait: null });
  const mia = { ...evelia, name: "Mia" };
  const miabelle = { ...miveth, name: "Miabelle" };
  assert.equal(split('"Hello," Miabelle asks.', undefined, [mia, miabelle])[0].speaker?.name, "Miabelle");
  assert.deepEqual(split('"Hello," Miabella asks.', undefined, [mia, miabelle])[0].speaker, { name: "NPC", portrait: null });
});

test("explicit speech attributions split two speakers inside one paragraph", () => {
  const text = '"Hello," *Miveth asks.* "Hi," *Evelia replies.*';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Miveth", "Narrator", "Evelia", "Narrator"]);
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("italic actions override character labels and initial character tags", () => {
  const text = 'Miveth: *She takes a step inside.* "Hello." *She pauses.*';
  const sections = split(text, `[speaker: Miveth]\n${text}`);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Miveth", "Narrator"]);
  assert.equal(sections.filter(s => s.speaker).map(s => s.content.trim()).join(""), '"Hello."');
});

test("emphasis inside spoken quotes reaches the Markdown renderer with raw text intact", () => {
  const text = 'Miveth: "You **must** stay. It is *important*."';
  const sections = split(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].speaker?.name, "Miveth");
  assert.equal(sections[0].content, '"You **must** stay. It is *important*."');
  assert.equal(sections[0].text, text);
});

test("escaped and nested star emphasis inside dialogue retains Markdown semantics", () => {
  for (const input of [
    '"hey so \\*I\\* did this"',
    '"hey so **I** did this"',
    '"hey so ***I*** did this"',
    '"hey so **I *really* did** this"',
    '"*\\*text\\**"',
    '"3 * 4 is 12, and the symbol is *"',
  ]) {
    const text = `Miveth: ${input}`;
    const sections = split(text);
    assert.equal(sections[0].speaker?.name, "Miveth");
    assert.equal(sections[0].content, input);
    assert.equal(sections[0].text, text);
  }
});

test("speech attribution before a quote assigns only that dialogue to the speaker", () => {
  const text = '*The door opens.* Miveth says quietly, "Hello." Evelia replies, "Hi."';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Narrator", "Miveth", "Narrator", "Evelia"]);
  assert.equal(sections.map(s => s.text).join(""), text);
});

test("quoted names, escaped quotes, and code do not confuse speech attribution", () => {
  const text = '"Miveth asks about \\"wine\\", **please**," Evelia replies.\n\n```text\n"Not dialogue," *Miveth asks.*\n```';
  const sections = split(text);
  assert.deepEqual(sections.map(s => s.speaker?.name ?? "Narrator"), ["Evelia", "Narrator"]);
  assert.ok(sections[0].content.includes('\\"wine\\", **please**'));
  assert.ok(sections[1].content.includes('"Not dialogue," *Miveth asks.*'));
  assert.equal(sections.map(s => s.text).join(""), text);
});
