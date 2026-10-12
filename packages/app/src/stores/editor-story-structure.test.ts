import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({ root: appRoot, configFile: false, envFile: false,
  appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
after(async () => { store.getState().stopAutosave(); await vite.close(); });

test("new stories enable structured routes and endings without selecting an interface", () => {
  store.getState().createNew();
  const draft = store.getState().worldDraft;
  assert.equal(draft.settings.storyStructureEnabled, true);
  assert.deepEqual(draft.routes, []);
  assert.deepEqual(draft.endings, []);
});

test("loading a Classic story preserves route and ending authoring fields", () => {
  const route = { id: "romance", name: "Romance", enabled: true, priority: 1, guidance: "Build trust.",
    conditions: [{ variableId: "trust", operator: "gte", value: 5 }], conditionLogic: "all", lockOnEntry: true };
  const ending = { id: "reunion", name: "Reunion", enabled: true, priority: 1, routeIds: ["romance"],
    conditions: [{ variableId: "trust", operator: "gte", value: 10 }], conditionLogic: "all", allowUnconditional: false,
    outcome: "The characters reunite.", mode: "authored", prose: "Together at last.", guidance: "" };
  store.getState().loadWorldFromData({ description: null, thumbnailUrl: null, id: "story", name: "Classic story", schema: {
    id: "story", version: "21.0.0", name: "Classic story", description: "", author: "", entries: [],
    variables: [{ id: "trust", name: "Trust", type: "number", defaultValue: 0 }], rules: [],
    routes: [route], endings: [ending], settings: { storyStructureEnabled: false },
  } });
  const draft = store.getState().worldDraft;
  assert.deepEqual(draft.routes, [route]);
  assert.deepEqual(draft.endings, [ending]);
  assert.equal(draft.settings.storyStructureEnabled, false);
  assert.equal(draft.variables[0]?.id, "trust");
});
