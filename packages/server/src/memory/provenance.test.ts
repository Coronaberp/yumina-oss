import assert from "node:assert/strict";
import test from "node:test";
import {
  sourceFingerprint,
  prefixAt,
  logicalTranscript,
} from "./provenance.js";

test("historical cutoffs use ordered identities even with tied timestamps", () => {
  const rows = [
    { id: "a", role: "user", content: "first" },
    { id: "b", role: "assistant", content: "old" },
    { id: "c", role: "user", content: "future" },
  ];
  assert.deepEqual(
    prefixAt(rows, "b").map((r) => r.id),
    ["a"],
  );
  assert.throws(() => prefixAt(rows, "missing"));
  assert.notEqual(
    sourceFingerprint(rows),
    sourceFingerprint([{ ...rows[0]!, content: "edited" }, ...rows.slice(1)]),
  );
});
test("continuation fragments normalize into one logical answer and selected swipe identity affects provenance", () => {
  const rows = [
    { id: "a", role: "user", content: "go" },
    { id: "b", role: "assistant", content: "one" },
    { id: "c", role: "assistant", content: "two" },
  ];
  assert.deepEqual(
    logicalTranscript(rows).map((r) => [r.role, r.content]),
    [
      ["user", "go"],
      ["assistant", "one\n\ntwo"],
    ],
  );
  assert.notEqual(
    sourceFingerprint(rows),
    sourceFingerprint(rows.map((r) => ({ ...r, selectedAnswerId: "v2" }))),
  );
});
