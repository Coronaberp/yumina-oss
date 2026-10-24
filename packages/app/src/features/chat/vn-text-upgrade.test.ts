import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { upgradeVnTextFiles } from "./vn-text-upgrade";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
const folder = new URL("../../../../../interfaces/vn/", import.meta.url);
const helpers = Object.fromEntries(["text-settings.tsx", "text-style.ts", "text-defaults.ts", "menu-layout.ts"].map(file => [file, readFileSync(new URL(file, folder), "utf8")]));
const current = readFileSync(new URL("index.tsx", folder), "utf8");
const old = current.replace('import { VnTextSettings, VnTextStyle } from "./text-settings";\n', "")
  .replace('<VnTextSettings api={api} onResetLegacy={() => onSetting("textSize", 27)} />', '<label className="vn-setting">Dialogue size<select value={settings.textSize} onChange={e => onSetting("textSize", Number(e.target.value))}><option value={23}>Small</option><option value={27}>Default</option><option value={32}>Large</option></select></label>')
  .replace('\n    <VnTextStyle api={api} />', "")
  .replace(', JSON.stringify(api.vnTextPreferences)', "")
  .replace('className="vn-overlay vn-menu-overlay"', 'className="vn-overlay"')
  .replace(`    <button className="vn-close vn-menu-close" aria-label="Close menu" onClick={onClose}>Close<MenuIcon api={api} name="close" /></button>
    <aside className="vn-drawer">`, `    <aside className="vn-drawer">
      <button className="vn-close vn-menu-close" aria-label="Close menu" onClick={onClose}>Close<MenuIcon api={api} name="close" /></button>`);
test("saved VN settings upgrade without changing authored art, code or defaults", () => {
  const defaults = 'export const vnTextDefaults = {"dialogue":{"size":30},"narration":{}};';
  for (const errorAware of [false, true]) {
    const source = errorAware ? old : old.replace('spriteLimit, error]', 'spriteLimit]');
    const expected = errorAware ? current : current.replace('spriteLimit, error, JSON.stringify(api.vnTextPreferences)]', 'spriteLimit, JSON.stringify(api.vnTextPreferences)]');
    const files = { "__user-root.tsx": source, "index.tsx": "composed root", "sprites.ts": "creator sprites", "text-defaults.ts": defaults };
    const upgraded = upgradeVnTextFiles(files, helpers);
    const ownImport = 'import { VnTextSettings, VnTextStyle } from "./text-settings";\n';
    assert.equal(upgraded["__user-root.tsx"].split(ownImport).length, 2, "Add exactly one settings import");
    // Only this upgrader's added import may move around newer stock imports.
    // Every other import, handler, layout and authored byte remains exact.
    assert.equal(upgraded["__user-root.tsx"].replace(ownImport, ""), expected.replace(ownImport, ""), errorAware ? "error-aware layout dependencies retain text preferences" : "older layout dependencies retain text preferences");
    assert.equal(upgraded["sprites.ts"], files["sprites.ts"]);
    assert.equal(upgraded["index.tsx"], "composed root");
    assert.equal(upgraded["text-defaults.ts"], defaults);
    assert.equal(upgradeVnTextFiles(upgraded, helpers), upgraded);
    assert.equal(files["__user-root.tsx"], source);
  }
});
test("Chat and custom VN settings remain unchanged", () => {
  const examples: Record<string, string>[] = [{ "index.tsx": "export default function World(){return <Chat/>;}" }, { "index.tsx": old.replace('function Menu({ api,', 'function CustomMenu({ api,') }, { "index.tsx": old, "text-settings.tsx": "creator custom settings" }];
  for (const files of examples) assert.equal(upgradeVnTextFiles(files, helpers), files);
});
test("shared and card style helpers stay identical", () => {
  assert.equal(helpers["text-style.ts"], readFileSync(new URL("../../../../shared/src/vn-text-style.ts", import.meta.url), "utf8"));
});
test("VN modules initialize in the card runtime", () => {
  const files = Object.fromEntries(readdirSync(folder).filter(name => /\.tsx?$/.test(name)).map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  const result = bundleAndCompile({ files, entryFile: "index.tsx" });
  assert.equal(result.error, null);
  assert.equal(typeof result.Component, "function");
});
