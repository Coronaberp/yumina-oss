import { describe, it, expect } from "vitest";
import { diffWorldSchemas } from "../diff/world-diff.js";
import type { WorldDefinition } from "../types/index.js";

const world = (data: Record<string, unknown> = {}) => ({ entries: [], variables: [], rules: [], audioTracks: [], ...data }) as unknown as WorldDefinition;
const compare = (before: WorldDefinition, after: WorldDefinition) => diffWorldSchemas(before, after, { detail: true, coverage: "all" });

describe("complete saved-version comparison", () => {
  it("compares fields omitted from the review diff without changing review semantics", () => {
    const before = world({ rules: [{ id: "r", name: "Rule", actions: ["old"] }], entries: [{ id: "e", content: "same", tags: ["old"], position: 0 }] });
    const after = world({ rules: [{ id: "r", name: "Rule", actions: ["new"] }], entries: [{ id: "e", content: "same", tags: ["new"], position: 1 }] });
    expect(diffWorldSchemas(before, after).changes).toEqual([]);
    const changes = compare(before, after).changes;
    expect(changes.find(c => c.id === "r")?.fields?.map(f => f.field)).toContain("actions");
    expect(changes.find(c => c.id === "e")?.fields?.map(f => f.field)).toEqual(["position", "tags"]);
  });

  it("covers every present root field, including future fields and inactive/custom interfaces", () => {
    const fields = { chapters: [1], settings: { temperature: 0.2 }, customUI: ["legacy"], components: ["panel"], interfaceDrafts: { custom: { files: { "x.tsx": "code" } } }, bgmPlaylist: ["song"], cardShowcase: { html: "<script>unsafe()</script>" }, futureField: { preserved: true }, worldbooks: ["lore"] };
    for (const [field, value] of Object.entries(fields)) {
      expect(compare(world(), world({ [field]: value })).changes.some(c => c.id === field), field).toBe(true);
    }
  });

  it("compares source files plus root metadata and includes added/removed values", () => {
    const before = world({ rootComponent: { entryFile: "old.tsx", files: { "gone.tsx": "old", "same.tsx": "before" } } });
    const after = world({ rootComponent: { entryFile: "new.tsx", files: { "added.tsx": "new", "same.tsx": "after" } } });
    const changes = compare(before, after).changes;
    expect(changes.find(c => c.id === "gone.tsx")).toMatchObject({ op: "removed", fields: [{ before: "old", afterType: "missing" }] });
    expect(changes.find(c => c.id === "added.tsx")).toMatchObject({ op: "added", fields: [{ after: "new", beforeType: "missing" }] });
    expect(changes.find(c => c.id === "rootComponent")).toMatchObject({ fields: [expect.objectContaining({ field: "entryFile", before: "old.tsx", after: "new.tsx" })] });
  });

  it("detects collection order, duplicate/missing IDs, and missing versus empty/null/types", () => {
    expect(compare(world({ entries: [{ id: "a" }, { id: "b" }] }), world({ entries: [{ id: "b" }, { id: "a" }] })).changes.some(c => c.id === "entries.order")).toBe(true);
    for (const rows of [[{ id: "a", content: 1 }, { id: "a", content: 2 }], [{ content: 1 }]]) {
      expect(compare(world({ entries: rows }), world({ entries: rows.map(r => ({ ...r, content: 3 })) })).changes).toHaveLength(1);
    }
    for (const [a, b] of [[undefined, ""], [null, "null"], [1, "1"], [false, "false"], [[], {}]]) {
      expect(compare(world({ custom: a }), world({ custom: b })).counts.modified).toBe(1);
    }
  });

  it("ignores object key order, preserves inputs, and finds deep changes in large content", () => {
    const before = world({ custom: { b: 2, a: 1 }, rootComponent: { files: { "index.tsx": "x".repeat(500_000) } } });
    const original = structuredClone(before);
    expect(compare(before, world({ ...before, custom: { a: 1, b: 2 } })).changes).toEqual([]);
    const after = structuredClone(before);
    after.rootComponent!.files["index.tsx"] += "changed at end";
    expect(compare(before, after).changes).toHaveLength(1);
    expect(before).toEqual(original);
  });
});
