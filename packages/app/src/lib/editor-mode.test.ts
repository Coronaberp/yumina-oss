import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

test("editor preference helpers load independently and retain existing storage behavior", async t => {
  assert.ok(existsSync(new URL("./editor-mode.ts", import.meta.url)), "preferences need a lightweight module instead of importing the editor");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    const { getEditorMode, saveEditorMode, getGlobalEditorMode, saveGlobalEditorMode } = await import("./editor-mode");
    await t.test("world modes keep their existing key and preserve other worlds", () => {
      values.clear();
      values.set("yumina-editor-mode", JSON.stringify({ other: "advanced" }));
      saveEditorMode("current", "simple");
      assert.equal(getEditorMode("current"), "simple");
      assert.equal(getEditorMode("other"), "advanced");
      assert.equal(getEditorMode("missing"), null);
      saveEditorMode("current", "advanced");
      assert.deepEqual(JSON.parse(values.get("yumina-editor-mode")!), { other: "advanced", current: "advanced" });
    });
    await t.test("global modes keep their independent existing key", () => {
      values.clear();
      assert.equal(getGlobalEditorMode(), null);
      saveGlobalEditorMode("simple");
      assert.equal(values.get("yumina-editor-mode-global"), "simple");
      assert.equal(getGlobalEditorMode(), "simple");
      saveGlobalEditorMode("advanced");
      assert.equal(getGlobalEditorMode(), "advanced");
      assert.equal(getEditorMode("current"), null);
      values.set("yumina-editor-mode-global", "unrecognized");
      assert.equal(getGlobalEditorMode(), null);
    });
    await t.test("malformed saved JSON does not crash or overwrite the original value", () => {
      values.set("yumina-editor-mode", "{broken");
      assert.equal(getEditorMode("current"), null);
      assert.doesNotThrow(() => saveEditorMode("current", "simple"));
      assert.equal(values.get("yumina-editor-mode"), "{broken");
    });
    await t.test("blocked storage is optional for both readers and writers", () => {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
      assert.equal(getEditorMode("current"), null);
      assert.equal(getGlobalEditorMode(), null);
      assert.doesNotThrow(() => saveEditorMode("current", "simple"));
      assert.doesNotThrow(() => saveGlobalEditorMode("advanced"));
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
