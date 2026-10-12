import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";

/**
 * Loading a world must not drop its fields. The save is a full-schema PATCH,
 * so anything the load forgets is deleted from the server on the next save —
 * silently, with no error.
 */

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");

beforeEach(() => {
  globalThis.fetch = async (url: unknown) => { throw new Error(`Unexpected network request: ${url}`); };
  memory.clear();
});
after(async () => { store.getState().stopAutosave(); await vite.close(); });

const SCHEMA = {
  id: "w1",
  version: "1.0.0",
  name: "A rainy port",
  variables: [{ id: "v1", name: "Trust", type: "number", defaultValue: 0 }],
  customTagColors: { rain: "#123456" },
  installedBundles: [{ installId: "i1", bundleId: "b1", name: "Pack" }],
  systems: ["weather"],
  language: "zh",
  someFutureField: { kept: true },
  settings: {
    lorebookTokenBudget: 3000,
    lorebookBudgetPercent: 30,
    lorebookBudgetCap: 4000,
    structuredOutput: true,
    temperature: 0.7,
  },
};

function load() {
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  return store.getState().worldDraft as unknown as Record<string, any>;
}

test("locked cards cannot change their draft or schedule a save", async () => {
  store.getState().loadWorldFromData({
    id: "w1", name: "Protected card", description: null, thumbnailUrl: null,
    schema: SCHEMA as unknown as Record<string, unknown>, editingLocked: true,
  });
  assert.equal(store.getState().editingLocked, true);
  const before = JSON.stringify(store.getState().worldDraft);
  store.getState().setField("name", "An attempted edit");
  assert.equal(JSON.stringify(store.getState().worldDraft), before);
  assert.equal(await store.getState().saveDraft(), false);
  assert.equal(store.getState().isDirty, false);
});

test("opening another card or a new project does not inherit the previous lock", () => {
  store.getState().loadWorldFromData({ id: "w1", name: "Locked", description: null, thumbnailUrl: null, schema: SCHEMA, editingLocked: true });
  load();
  assert.equal(store.getState().editingLocked, false);
  store.getState().setField("name", "Editable card");
  assert.equal(store.getState().worldDraft.name, "Editable card");
  store.getState().loadWorldFromData({ id: "w1", name: "Locked", description: null, thumbnailUrl: null, schema: SCHEMA, editingLocked: true });
  store.getState().createNew();
  assert.equal(store.getState().editingLocked, false);
});

test("tagging a custom entry as a character sets its runtime role and remains undoable", () => {
  for (const tag of ["Character", "Characters", " characters "]) {
    load();
    const actions = store.getState();
    actions.addEntry("custom");
    const id = store.getState().worldDraft.entries.at(-1)!.id;
    actions.updateEntry(id, { name: "Sera", content: "Authored character details." });
    actions.updateEntry(id, { tags: [tag] });
    const updated = store.getState().worldDraft.entries.find(e => e.id === id)!;
    assert.equal(updated.role, "character");
    assert.equal(updated.content, "Authored character details.");
    actions.undo();
    assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "custom");
    actions.redo();
    assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "character");
    actions.updateEntry(id, { tags: [] });
    assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "character", "removing an organizational tag does not demote a character");
  }
});

test("character tags preserve deliberate roles and presets", () => {
  load();
  const actions = store.getState();
  for (const role of ["system", "lore", "scenario", "example"] as const) {
    actions.addEntry(role);
    const id = store.getState().worldDraft.entries.at(-1)!.id;
    actions.updateEntry(id, { tags: ["Characters"] });
    assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, role);
  }
  actions.addEntry("custom");
  const id = store.getState().worldDraft.entries.at(-1)!.id;
  actions.updateEntry(id, { presetId: "qa-preset", tags: ["Characters"] });
  assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "custom");
  actions.updateEntry(id, { presetId: undefined, role: "custom", tags: ["Characters"] });
  assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "custom", "an explicit role update takes precedence");
  actions.updateEntry(id, { tags: ["Plot"] });
  assert.equal(store.getState().worldDraft.entries.find(e => e.id === id)!.role, "custom");
});

test("interface selection and archived file edits survive loading and switching", () => {
  load();
  const source = { id: "root", name: "Custom art", interfaceId: "custom:art", entryFile: "index.tsx", files: { "index.tsx": "export default function Art(){ return <Chat />; }", "sprites.ts": "edited" }, updatedAt: "before" };
  const loaded = store.getState().worldDraft;
  store.getState().loadWorldFromData({ id: "w1", name: loaded.name, description: null, thumbnailUrl: null, schema: { ...loaded, rootComponent: source } });
  store.getState().selectInterface("classic", { id: "classic", name: "Classic", entryFile: "index.tsx", files: { "index.tsx": "export default function MyWorld(){return <Chat/>;}" } });
  const changed = JSON.parse(JSON.stringify(store.getState().worldDraft));
  assert.equal(changed.rootComponent.interfaceId, "classic");
  store.getState().loadWorldFromData({ id: "w1", name: loaded.name, description: null, thumbnailUrl: null, schema: changed });
  store.getState().selectInterface("custom:art", source);
  const restored = store.getState().worldDraft;
  assert.deepEqual(restored.rootComponent?.files, source.files);
  assert.deepEqual(restored.variables, loaded.variables);
});

test("world-level fields outside the old field list survive being loaded", () => {
  const draft = load();
  assert.deepEqual(draft.customTagColors, { rain: "#123456" });
  assert.equal(draft.installedBundles?.[0]?.installId, "i1");
  assert.deepEqual(draft.systems, ["weather"]);
  assert.equal(draft.language, "zh");
  assert.deepEqual(draft.someFutureField, { kept: true }, "a field added later must ride through too");
});

test("settings outside the old field list survive, and defaults still fill gaps", () => {
  const settings = load().settings;
  assert.equal(settings.lorebookTokenBudget, 3000);
  assert.equal(settings.lorebookBudgetPercent, 30);
  assert.equal(settings.lorebookBudgetCap, 4000);
  assert.equal(settings.structuredOutput, true);
  assert.equal(settings.temperature, 0.7);
  assert.equal(settings.maxTokens, 12000);
  assert.equal(settings.playerName, "User");
});
