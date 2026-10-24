import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSnapshotTimeline } from "./snapshot-summary.js";
import * as snapshotSummaries from "./snapshot-summary.js";
import type { WorldDiff } from "@yumina/engine";

const W = (entries: unknown[]) => ({ entries, variables: [], rules: [], reactions: [], audioTracks: [] }) as any;

test("pairs each snapshot with the next newer state; newest pairs with current world", () => {
  // oldest -> newest
  const snaps = [
    { id: "s1", schemaData: W([]) },                                  // before adding e1
    { id: "s2", schemaData: W([{ id: "e1", name: "A" }]) },           // before adding e2
  ];
  const current = W([{ id: "e1", name: "A" }, { id: "e2", name: "B" }]);
  const out = summarizeSnapshotTimeline(snaps, current);

  // s2 (newest) vs current -> added e2
  assert.equal(out.find((r) => r.id === "s2")!.summary[0]!.op, "added");
  assert.equal(out.find((r) => r.id === "s2")!.summary[0]!.name, "B");
  // s1 vs s2 -> added e1
  assert.equal(out.find((r) => r.id === "s1")!.summary[0]!.name, "A");
});

test("oldest snapshot with no prior produces a summary against its successor only", () => {
  const out = summarizeSnapshotTimeline([{ id: "s1", schemaData: W([]) }], W([{ id: "e1", name: "A" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.summary[0]!.op, "added");
});

test("empty input returns empty array", () => {
  assert.deepEqual(summarizeSnapshotTimeline([], W([])), []);
});


const material = (schema: Record<string, unknown>, thumbnailUrl: string | null) => ({ kind: "studio-world-material", version: 1, schema, thumbnailUrl });
const crop = (x: number) => ({ x, y: 0, zoom: 1, fit: "cover" });
function diffMaterial(before: unknown, after: unknown, options: { detail?: boolean } = {}): WorldDiff {
  const differ = (snapshotSummaries as unknown as Record<string, unknown>).diffStudioSnapshotMaterials;
  assert.equal(typeof differ, "function", "snapshot summaries need a reusable full-material diff");
  return (differ as (before: unknown, after: unknown, options: { detail?: boolean }) => WorldDiff)(before, after, options);
}

test("new snapshots diff portrait-only changes and clears without inventing schema avatars", () => {
  const schema = { ...W([]), customData: { preserved: ["yes", 8] } };
  const before = material(schema, "@asset:old");
  const after = material(structuredClone(schema), "@asset:new");
  const original = structuredClone({ before, after });
  assert.deepEqual(diffMaterial(before, after, { detail: true }), {
    changes: [{ kind: "meta", op: "modified", id: "thumbnailUrl", name: "thumbnailUrl", fields: [{ field: "thumbnailUrl", before: "@asset:old", after: "@asset:new" }] }],
    counts: { added: 0, removed: 0, modified: 1 },
  });
  assert.deepEqual(diffMaterial(after, material(schema, null)).changes, [{ kind: "meta", op: "modified", id: "thumbnailUrl", name: "thumbnailUrl" }]);
  assert.equal(diffMaterial(after, material(schema, null), { detail: true }).changes[0]!.fields![0]!.after, "");
  assert.deepEqual({ before, after }, original);
  assert.equal("avatar" in schema, false);
});

test("wrapped snapshots include independent banner and framing plus ordinary schema changes", () => {
  const before = { ...W([{ id: "intro", name: "Intro", content: "Old" }]), coverCrop: crop(0), bannerImageUrl: "@asset:old-banner", bannerCrop: crop(0), customPayload: { literal: true } };
  const after = { ...structuredClone(before), entries: [{ id: "intro", name: "Intro", content: "New" }], coverCrop: crop(4), bannerImageUrl: "@asset:new-banner", bannerCrop: crop(8) };
  const diff = diffMaterial(material(before, "@asset:old-cover"), material(after, "@asset:new-cover"), { detail: true });
  assert.deepEqual(diff.changes.map(change => change.id), ["intro", "coverCrop", "bannerImageUrl", "bannerCrop", "thumbnailUrl"]);
  assert.deepEqual(diff.counts, { added: 0, removed: 0, modified: 5 });
  assert.deepEqual(after.customPayload, { literal: true });
  assert.deepEqual(diff.changes.find(change => change.id === "coverCrop")!.fields, [{ field: "coverCrop", before: JSON.stringify(crop(0)), after: JSON.stringify(crop(4)) }]);
});

test("mixed and legacy snapshots preserve unknown historical portrait while diffing real schemas", () => {
  const old = { ...W([]), bannerImageUrl: "@asset:old", customField: { preserved: true } };
  const next = { ...structuredClone(old), bannerImageUrl: "@asset:new" };
  for (const [before, after] of [[old, next], [old, material(next, "@asset:cover")], [material(old, null), next]]) {
    assert.deepEqual(diffMaterial(before, after).changes, [{ kind: "meta", op: "modified", id: "bannerImageUrl", name: "bannerImageUrl" }]);
  }
  const out = summarizeSnapshotTimeline([{ id: "legacy", schemaData: old }, { id: "new", schemaData: material(next, "@asset:cover") }], material(next, null));
  assert.deepEqual(out, [
    { id: "legacy", summary: [{ kind: "meta", op: "modified", id: "bannerImageUrl", name: "bannerImageUrl" }] },
    { id: "new", summary: [{ kind: "meta", op: "modified", id: "thumbnailUrl", name: "thumbnailUrl" }] },
  ]);
});
