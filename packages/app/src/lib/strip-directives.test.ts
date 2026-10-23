import assert from "node:assert/strict";
import test from "node:test";
import { stripDirectives, stripDirectivesForSandbox } from "./strip-directives";

test("streaming text hides variable-update wrappers as well as their state directives", () => {
  const raw = 'The clerk waits.\n<Variable-updates>\n[time-period: set "9:10 AM"]\n</Variable-updates>';
  assert.equal(stripDirectives(raw).trim(), "The clerk waits.");
  assert.equal(stripDirectivesForSandbox('[speaker: Clerk]\n' + raw).trim(), '[speaker: Clerk]\nThe clerk waits.');
});

test("streaming hides angle tags while keeping literal examples", () => {
  const declared = ["current-period"];
  const text = '[speaker: Cinder]\nThe lamps glow.\n<current-period: set "evening">';
  assert.equal(stripDirectivesForSandbox(text, declared).trim(), '[speaker: Cinder]\nThe lamps glow.');
  assert.equal(stripDirectives('The lamps glow.\n<current-period: set "eve', declared).trim(), "The lamps glow.");
  for (const literal of ['`<current-period: set "evening">`', '“Use <current-period: set evening> as an example.”'])
    assert.equal(stripDirectives(literal, declared), literal);
});

test("stripDirectives removes a completed speaker tag like any other directive", () => {
  assert.equal(stripDirectives("[speaker: Balder] The forge roars. [hp: -1]"), " The forge roars. ");
});

test("stripDirectivesForSandbox keeps the leading speaker tag and strips the rest", () => {
  assert.equal(
    stripDirectivesForSandbox("[speaker: Balder]  \nThe forge roars. [hp: -1]"),
    "[speaker: Balder]\nThe forge roars. ",
  );
  assert.equal(stripDirectivesForSandbox("[speaker: Mia Chen] Hi."), "[speaker: Mia Chen]\n Hi.");
});

test("stripDirectivesForSandbox holds a partial leading tag instead of leaking it", () => {
  for (const partial of ["[", "[s", "[spea", "[speaker", "[speaker:", "[speaker: Bal"]) {
    assert.equal(stripDirectivesForSandbox(partial), partial, partial);
  }
});

test("stripDirectivesForSandbox is the plain stripper when there is no tag", () => {
  assert.equal(stripDirectivesForSandbox("Plain prose. [gold: +5]"), "Plain prose. ");
  assert.equal(stripDirectivesForSandbox("Text first. [speaker: Mia]"), "Text first. ");
});


test("all streamed angle-tag prefixes are hidden without depending on their spelling", () => {
  const tag = '<Yunmina-state version="1" status="updated" count="3" />';
  for (let i = 1; i <= tag.length; i++) assert.equal(stripDirectives('Story.\n' + tag.slice(0, i)), 'Story.\n');
  assert.equal(stripDirectives('<unknown: set "evening">'), '');
  assert.equal(stripDirectives('<unknown>Kept prose</unknown>'), 'Kept prose');
});

test("streaming hides directives for dotted character names and scalar merges", () => {
  assert.equal(stripDirectives("她笑了。[relations.艾丝·华伦斯坦: +20]"), "她笑了。");
  assert.equal(stripDirectives("他点头。[relations.韦尔夫·克罗佐: merge 20]"), "他点头。");
  assert.equal(stripDirectives('好。[relations.リリ・アーデ: merge {"trust": 30}]'), "好。");
  assert.equal(stripDirectives("She nods. [relations.Riveria Ljos Alf: +1]"), "She nods. ");
  assert.equal(stripDirectives("Asiente. [relations.Bell Cranel: merge 20]"), "Asiente. ");
});

test("incomplete named directives stay hidden while bracketed prose stays readable", () => {
  for (const tail of ["[relations.艾丝·华伦斯坦: +", "[relations.Riveria Ljos Alf: merge {"]) {
    assert.equal(stripDirectives("She waits. " + tail), "She waits. ");
  }
  assert.equal(stripDirectives("[Chapter One: Begin] The road."), "[Chapter One: Begin] The road.");
  assert.equal(stripDirectivesForSandbox("[speaker: Riveria Ljos Alf] She nods. [relations.Riveria Ljos Alf: +1]"),
    "[speaker: Riveria Ljos Alf]\n She nods. ");
});

test("streaming retains named directives in literal examples alongside active updates", () => {
  for (const literal of [
    '`[relations.Riveria Ljos Alf: +1]`',
    '“[relations.リリ・アーデ: merge {"trust": 30}]”',
  ]) {
    assert.equal(stripDirectives(literal), literal);
    assert.equal(stripDirectivesForSandbox(`[speaker: Riveria] ${literal} [relations.Riveria Ljos Alf: +1]`),
      `[speaker: Riveria]\n ${literal} `);
  }
});
