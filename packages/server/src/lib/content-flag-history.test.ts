import test from "node:test";
import assert from "node:assert/strict";
import { withoutContentFlags } from "./content-flag-history.js";

test("audit-only changes leave generation fingerprints stable, visible and state edits do not", () => {
  const row = { content: "Welcome", choices: ["Read"], stateSnapshot: { trust: 1 }, contentFlags: { label: "nsfw" } };
  const before = JSON.stringify(withoutContentFlags([row]));
  assert.equal(JSON.stringify(withoutContentFlags([{ ...row, contentFlags: { label: "sfw" } }])), before);
  for (const edit of [{ content: "Edited" }, { choices: ["Leave"] }, { stateSnapshot: { trust: 2 } }]) {
    assert.notEqual(JSON.stringify(withoutContentFlags([{ ...row, ...edit }])), before);
  }
  assert.equal(row.contentFlags.label, "nsfw");
  assert.equal(withoutContentFlags(null), null);
});
