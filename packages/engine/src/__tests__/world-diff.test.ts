import { describe, it, expect } from "vitest";
import { diffWorldSchemas } from "../diff/world-diff.js";
import type { WorldDefinition } from "../types/index.js";

// Minimal world builder — diffWorldSchemas tolerates missing collections.
function w(partial: Partial<WorldDefinition>): WorldDefinition {
  return { entries: [], variables: [], rules: [], reactions: [], audioTracks: [], ...partial } as unknown as WorldDefinition;
}

describe("diffWorldSchemas", () => {
  it("detects an added entry by id, with name", () => {
    const prev = w({ entries: [] });
    const next = w({ entries: [{ id: "e1", name: "铃花", content: "..." } as any] });
    const diff = diffWorldSchemas(prev, next);
    expect(diff.counts).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(diff.changes[0]).toMatchObject({ kind: "entry", op: "added", id: "e1", name: "铃花" });
  });

  it("detects a removed variable", () => {
    const prev = w({ variables: [{ id: "v1", name: "夜晚" } as any] });
    const next = w({ variables: [] });
    const diff = diffWorldSchemas(prev, next);
    expect(diff.changes).toEqual([{ kind: "variable", op: "removed", id: "v1", name: "夜晚" }]);
    expect(diff.counts.removed).toBe(1);
  });

  it("detects a modified entry and omits field text when detail=false", () => {
    const prev = w({ entries: [{ id: "e1", name: "开场白", content: "很安静" } as any] });
    const next = w({ entries: [{ id: "e1", name: "开场白", content: "传来脚步声" } as any] });
    const summary = diffWorldSchemas(prev, next);
    expect(summary.changes[0]).toMatchObject({ kind: "entry", op: "modified", id: "e1", name: "开场白" });
    expect(summary.changes[0]!.fields).toBeUndefined();
  });

  it("includes before/after field text when detail=true", () => {
    const prev = w({ entries: [{ id: "e1", name: "开场白", content: "很安静" } as any] });
    const next = w({ entries: [{ id: "e1", name: "开场白", content: "传来脚步声" } as any] });
    const detail = diffWorldSchemas(prev, next, { detail: true });
    expect(detail.changes[0]!.fields).toContainEqual({ field: "content", before: "很安静", after: "传来脚步声" });
  });

  it("includes character portrait replacements in the reviewer diff", () => {
    const character = { id: "alice", name: "Alice", role: "character", content: "An explorer" };
    const before = w({ entries: [{ ...character, portrait: "@asset:old" } as any] });
    const after = w({ entries: [{ ...character, portrait: "@asset:new" } as any] });
    expect(diffWorldSchemas(before, after, { detail: true }).changes[0]).toMatchObject({
      kind: "entry", op: "modified", id: "alice",
      fields: [{ field: "portrait", before: "@asset:old", after: "@asset:new" }],
    });
  });

  it("falls back to id when name is absent", () => {
    const prev = w({ rules: [] });
    const next = w({ rules: [{ id: "r1", enabled: true } as any] });
    expect(diffWorldSchemas(prev, next).changes[0]).toMatchObject({ kind: "rule", op: "added", id: "r1", name: "r1" });
  });

  it("diffs rootComponent.files (customUI) by filename", () => {
    const prev = w({ rootComponent: { files: { "index.tsx": "old" } } as any });
    const next = w({ rootComponent: { files: { "index.tsx": "new", "panel.tsx": "x" } } as any });
    const diff = diffWorldSchemas(prev, next, { detail: true });
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: "customUI", op: "added", id: "panel.tsx", name: "panel.tsx" }));
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: "customUI", op: "modified", id: "index.tsx" }));
  });

  it("diffs meta scalars (name/description)", () => {
    const prev = w({ name: "A", description: "x" });
    const next = w({ name: "B", description: "x" });
    const diff = diffWorldSchemas(prev, next, { detail: true });
    expect(diff.changes).toContainEqual({ kind: "meta", op: "modified", id: "name", name: "name", fields: [{ field: "name", before: "A", after: "B" }] });
  });

  it("returns empty diff for identical schemas", () => {
    const a = w({ entries: [{ id: "e1", name: "x", content: "c" } as any] });
    expect(diffWorldSchemas(a, a).changes).toEqual([]);
  });
});


describe("card artwork metadata", () => {
  it("reports portrait framing, banner artwork and banner framing independently", () => {
    const before = w({ coverCrop: { x: 0, y: 0, zoom: 1, fit: "cover" }, bannerImageUrl: "@asset:11111111-1111-4111-8111-111111111111", bannerCrop: { x: 0, y: 0, zoom: 1, fit: "contain" } });
    const after = w({ coverCrop: { x: 5, y: 0, zoom: 0.8, fit: "cover" }, bannerImageUrl: "@asset:22222222-2222-4222-8222-222222222222", bannerCrop: { x: 0, y: 2, zoom: 0.7, fit: "cover" } });
    const summary = diffWorldSchemas(before, after);
    expect(summary.counts).toEqual({ added: 0, removed: 0, modified: 3 });
    expect(summary.changes).toEqual(["coverCrop", "bannerImageUrl", "bannerCrop"].map(field => ({ kind: "meta", op: "modified", id: field, name: field })));
    const detail = diffWorldSchemas(before, after, { detail: true });
    for (const field of ["coverCrop", "bannerImageUrl", "bannerCrop"] as const) {
      expect(detail.changes.find(change => change.id === field)?.fields).toEqual([{ field, before: typeof before[field] === "string" ? before[field] : JSON.stringify(before[field]), after: typeof after[field] === "string" ? after[field] : JSON.stringify(after[field]) }]);
    }
  });

  it("reports banner removal and leaves unrelated custom schema content untouched", () => {
    const before = { ...w({ bannerImageUrl: "@asset:11111111-1111-4111-8111-111111111111" }), customPayload: { retained: ["literal", { foo: "bar" }] } };
    const original = structuredClone(before);
    const after = { ...structuredClone(before), bannerImageUrl: "" };
    expect(diffWorldSchemas(before, after, { detail: true }).changes).toEqual([{ kind: "meta", op: "modified", id: "bannerImageUrl", name: "bannerImageUrl", fields: [{ field: "bannerImageUrl", before: before.bannerImageUrl, after: "" }] }]);
    expect(before).toEqual(original); expect(after.customPayload).toEqual(original.customPayload);
    expect(diffWorldSchemas(before, structuredClone(before)).changes).toEqual([]);
  });
});
