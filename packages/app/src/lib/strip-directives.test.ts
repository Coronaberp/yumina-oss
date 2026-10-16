import assert from "node:assert/strict";
import test from "node:test";
import { stripDirectives, stripDirectivesForSandbox } from "./strip-directives";

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

test("stripDirectives hides dot-path tags whose key has a middle dot, and bare-scalar merges", () => {
  assert.equal(stripDirectives("她笑了。[relations.艾丝·华伦斯坦: +20]"), "她笑了。");
  assert.equal(stripDirectives("他点头。[relations.韦尔夫·克罗佐: merge 20]"), "他点头。");
  assert.equal(stripDirectives('好。[relations: merge {"莉莉露卡·厄德": 30}]'), "好。");
});

test("stripDirectives hides dot-path tags whose key has spaces, but keeps bracketed prose", () => {
  assert.equal(stripDirectives("She nods. [relations.Riveria Ljos Alf: +1]"), "She nods. ");
  assert.equal(stripDirectives("Asiente. [relations.Bell Cranel: merge 20]"), "Asiente. ");
  assert.equal(stripDirectives("[Chapter One: Begin] The road."), "[Chapter One: Begin] The road.");
});
