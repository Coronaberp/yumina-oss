import assert from "node:assert/strict";
import test from "node:test";
import { characterIdentity } from "./story-character-identity.js";

test("identity fields are recovered wherever they occur, without unrelated biography text", () => {
  const identity = characterIdentity({ id: "sera", name: "Sera (Seraphine)", content: "Biography\n" + "Long childhood detail. ".repeat(200) + "\n**Full Name:** Seraphine\n**Age:** 247 (appears mid-twenties)\nSpecies: Angel\nOccupation: Military Strategy & Divine Combat Instructor. Not a student.\nPersonality: Aloof." });
  assert.match(identity.facts, /Full Name: Seraphine/);
  assert.match(identity.facts, /247 \(appears mid-twenties\)/);
  assert.match(identity.facts, /Species: Angel/);
  assert.doesNotMatch(identity.facts, /childhood|Personality/);
  assert.ok(identity.aliases.includes("Sera") && identity.aliases.includes("Seraphine"));
  assert.doesNotMatch(identity.searchText, /student/);
});

test("freeform characters preserve authored text instead of inventing structured facts", () => {
  const identity = characterIdentity({ id: "mira", name: "Mira", content: "Mira is a fire mage who teaches in the mountains." });
  assert.equal(identity.facts, "Mira is a fire mage who teaches in the mountains.");
});
