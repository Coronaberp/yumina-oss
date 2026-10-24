import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { compareVersionDraft } from "./version-comparison-data";

const schema = { id: "world", name: "Story", entries: [], variables: [], rules: [], audioTracks: [], custom: { preserved: "literal <script>code</script>" } };

test("compares external cover and rating while preserving every stored schema field", () => {
  const saved = { schema, thumbnailUrl: "@asset:old", ageRating: "all" };
  const draft = { ...schema, avatar: "@asset:new" } as unknown as WorldDefinition;
  const before = structuredClone({ saved, draft });
  const diff = compareVersionDraft({ saved, draft, currentAgeRating: "adult" });
  assert.deepEqual(diff.changes.map(change => change.id), ["snapshot.thumbnailUrl", "snapshot.ageRating"]);
  assert.deepEqual({ saved, draft }, before);
  assert.equal(compareVersionDraft({ saved, draft: { ...draft, avatar: saved.thumbnailUrl }, currentAgeRating: "all" }).changes.length, 0);
});

test("does not report identical when an old snapshot contains an unused legacy avatar", () => {
  const saved = { schema: { ...schema, avatar: "legacy schema field" }, thumbnailUrl: "@asset:cover", ageRating: "all" };
  const diff = compareVersionDraft({ saved, draft: { ...schema, avatar: "@asset:cover" } as unknown as WorldDefinition, currentAgeRating: "all" });
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0]?.id, "avatar");
  assert.equal(diff.changes[0]?.fields?.[0]?.before, "legacy schema field");
  assert.equal(diff.changes[0]?.fields?.[0]?.afterType, "missing");
});
