import assert from "node:assert/strict";
import test from "node:test";
import { type WorldDefinition } from "@yumina/engine";
import { neededStoryCharacters } from "./story-character-context.js";
import { requestsCharacterLookup } from "./story-character-identity.js";

const academy = (entries: unknown[]) => ({ entries, worldbooks: [], loreUiBindings: [] }) as unknown as WorldDefinition;
const character = (id: string, name: string, content: string) => ({ id, name, content, role: "character", enabled: true, keywords: [], conditions: [] });
const sera = character("sera", "Sera (Seraphine)", "Full Name: Seraphine\nAge: 247 (appears mid-twenties)\nSpecies: Angel\nOccupation: Military Strategy & Divine Combat Instructor. She is not a first-year student.");

test("an unnamed occupation selects the authored instructor before a hundred negative distractors", () => {
  const world = academy([sera, ...Array.from({ length: 100 }, (_, i) => character(`extra-${i}`, `Staff ${i}`, "Full Name: Staff\nSpecies: Human\nOccupation: Music tutor. Not a divine combat instructor."))]);
  assert.deepEqual(neededStoryCharacters(world, "Observe the divine combat instructor at orientation.").map(e => e.id), ["sera"]);
});

test("empty scenes and vague crowds do not cause spare-space biography selection", () => {
  const world = academy([sera]);
  assert.deepEqual(neededStoryCharacters(world, "I enter the empty storeroom. No characters or other people are present."), []);
  assert.deepEqual(neededStoryCharacters(world, "Observe the crowd from the back row."), []);
});

test("name aliases still resolve selectively and ambiguous short names do not resolve", () => {
  const world = academy([sera, character("winter", "Ann Winter", "Ann guards the vault."), character("summer", "Ann Summer", "Ann guards a garden.")]);
  assert.deepEqual(neededStoryCharacters(world, "Ask Seraphine about her lesson.").map(e => e.id), ["sera"]);
  assert.deepEqual(neededStoryCharacters(world, "Talk to Ann."), []);
});

test("unrecognized and non-English role requests remain eligible for semantic discovery", () => {
  assert.equal(requestsCharacterLookup("Follow the librarian to the archive."), true);
  assert.equal(requestsCharacterLookup("Je parle au bibliothécaire."), true);
});
