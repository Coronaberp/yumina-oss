import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { collectPreviewGreetings } from "./preview-greetings";

test("preview keeps opening identities aligned when blank and disabled greetings are removed", () => {
  const entries = [
    { id: "blank", role: "greeting", enabled: true, content: "  ", position: 0 },
    { id: "second", role: "greeting", enabled: true, content: " Second opening ", position: 2 },
    { id: "disabled", role: "greeting", enabled: false, content: "Hidden", position: 0 },
    { id: "first", role: "greeting", enabled: true, content: " First opening " },
  ] as WorldDefinition["entries"];
  const before = structuredClone(entries);
  assert.deepEqual(collectPreviewGreetings({ entries, settings: {} as WorldDefinition["settings"] }), [
    { id: "first", content: "First opening" }, { id: "second", content: "Second opening" },
  ]);
  assert.deepEqual(entries, before);
});

test("legacy preview greetings have no invented opening ID", () => {
  assert.deepEqual(collectPreviewGreetings({ entries: [], settings: { greeting: " Legacy opening " } as WorldDefinition["settings"] }), [{ id: null, content: "Legacy opening" }]);
  assert.deepEqual(collectPreviewGreetings(undefined), []);
});
