import { test } from "vitest";
import assert from "node:assert/strict";
import { readCardShowcase, updateCardShowcase } from "../world/card-showcase.js";
import { worldDefinitionSchema } from "../world/schema.js";
import { mergeWorldDefinition } from "../world/merge.js";
import type { WorldDefinition } from "../types/index.js";

const base = { id: "card", version: "21.0.0", name: "Card", description: "Public description", author: "Creator", entries: [], variables: [], rules: [], components: [], audioTracks: [], customUI: [], settings: {}, cardShowcase: { html: "<h1>Original</h1>", css: "h1 {color:gold;}" } } as WorldDefinition;

test("the world schema retains public showcase HTML/CSS across JSON saves", () => {
  const saved = JSON.parse(JSON.stringify(base));
  assert.deepEqual(worldDefinitionSchema.parse(saved).cardShowcase, base.cardShowcase);
  assert.deepEqual(readCardShowcase(undefined), { html: "", css: "" });
});

test("CSS-only updates and clears retain the public HTML", () => {
  const result = updateCardShowcase(base.cardShowcase, { css: "h1 {color:pink;}" });
  assert.equal(result.html, base.cardShowcase!.html);
  assert.equal(updateCardShowcase(result, { css: "" }).html, result.html);
  assert.equal(base.cardShowcase!.css, "h1 {color:gold;}");
});

test("showcase inputs enforce bounds and exclude character overrides", () => {
  for (const value of [{ html: 1 }, { css: "x".repeat(30001) }, { html: "x".repeat(100001) }, { characters: { sera: "body{}" } }]) {
    assert.throws(() => readCardShowcase(value));
  }
});

test("editor HTML and agent CSS changes merge without losing either", () => {
  const local = { ...base, cardShowcase: { ...base.cardShowcase!, html: "<h1>Editor content</h1>" } };
  const server = { ...base, cardShowcase: { ...base.cardShowcase!, css: "h1 {color:pink;}" } };
  const result = mergeWorldDefinition(base, local, server);
  assert.deepEqual(result.merged.cardShowcase, { html: "<h1>Editor content</h1>", css: "h1 {color:pink;}" });
  assert.deepEqual(result.conflicts, []);
});

test("competing showcase edits keep the editor version and report the conflict", () => {
  const local = { ...base, cardShowcase: { ...base.cardShowcase!, css: "h1 {color:pink;}" } };
  const server = { ...base, cardShowcase: { ...base.cardShowcase!, css: "h1 {color:navy;}" } };
  const result = mergeWorldDefinition(base, local, server);
  assert.equal(result.merged.cardShowcase!.css, local.cardShowcase.css);
  assert.ok(result.conflicts.some(conflict => conflict.id === "cardShowcase.css"));
});
