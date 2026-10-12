import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const values = new Map<string, string>();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)), removeItem: key => void values.delete(key), clear: () => values.clear(), key: () => null, length: 0 };
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { worldEntrySchema } = await vite.ssrLoadModule(fileURLToPath(new URL("../../../engine/src/world/schema.ts", import.meta.url)));
after(async () => { useEditorStore.getState().stopAutosave(); await vite.close(); });
test("lore edits and undo preserve authored memory metadata through JSON schema roundtrip", () => {
  const store = useEditorStore.getState(); store.createNew(); store.stopAutosave();
  store.addEntry("lore");
  const entry = useEditorStore.getState().worldDraft.entries.at(-1)!;
  const memory = { hidden: true, metadata: { category: "history", tags: ["secret"] }, links: [{ targetId: "other", label: "knows" }], secrets: ["A secret"] };
  store.updateEntry(entry.id, { memory });
  store.updateEntry(entry.id, { content: "Edited lore" });
  const saved = worldEntrySchema.parse(JSON.parse(JSON.stringify(useEditorStore.getState().worldDraft.entries.find(e => e.id === entry.id))));
  assert.deepEqual(saved.memory, memory);
  store.undo();
  assert.deepEqual(useEditorStore.getState().worldDraft.entries.find(e => e.id === entry.id)?.memory, memory);
  store.redo();
  assert.equal(useEditorStore.getState().worldDraft.entries.find(e => e.id === entry.id)?.content, "Edited lore");
});
