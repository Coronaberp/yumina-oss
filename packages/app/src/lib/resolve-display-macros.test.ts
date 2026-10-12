import assert from "node:assert/strict";
import test from "node:test";
import { resolveDisplayMacros } from "./resolve-display-macros";

test("VN keeps the player token until presentation while Classic resolves the persona name", () => {
  const text = "{{char}} offers {{user}} a seat. {{USER}}'s coat is blue.";
  assert.equal(resolveDisplayMacros(text, "Robin", "Evelia", true), "Evelia offers {{user}} a seat. {{user}}'s coat is blue.");
  assert.equal(resolveDisplayMacros(text, "Robin", "Evelia"), "Evelia offers Robin a seat. Robin's coat is blue.");
});

test("both interfaces discard zero-width spaces from old prose and resolved names", () => {
  for (const preserveUser of [true, false]) {
    assert.equal(resolveDisplayMacros("Hel\u200Blo, {{char}}.", "You", "Se\u200Bra", preserveUser), "Hello, Sera.");
  }
});
