import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RootComponent, Variable } from "@yumina/engine";
import { initialStatusConfig, installStatusVisualization, readStatusConfig, writeStatusConfig } from "./status-visualizations";
import { defaultStatusCategories, normalizeStatusConfig, statusItems, statusRange, statusValue } from "../../../../../../interfaces/vn/status-data";
import * as statusEditor from "./status-visualizations";

const variable = { id: "hp-id", name: "HP", type: "number", defaultValue: 84, min: 0, max: 100 } as Variable;
test("preview controls address authored tabs by stable ID and only accept their parent", async () => {
  const React = await import("react");
  const { JSDOM } = await import("jsdom");
  const { bundleAndCompile } = await import("../../studio/lib/tsx-bundler");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test/sandbox?parentOrigin=https%3A%2F%2Fyumina.test" });
  const globals = { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const folder = new URL("../../../../../../interfaces/vn/", import.meta.url);
  const templates = Object.fromEntries(["status-data.ts", "status-view.tsx", "status-sheet.tsx", "status-layout.tsx", "status-gauge.tsx", "status-widgets.tsx"].map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  const config = { ...initialStatusConfig([variable]), groups: [{ id: "one", label: "Same" }, { id: "two", label: "Same" }, { id: "empty", label: "Empty" }] };
  const files = { ...templates, "styles.ts": 'export const styles = ".vn .vn-subpanel button{width:100%}";',
    "status-layout.tsx": `export default function Layout({config,variables}){
      const [active,setActive]=React.useState(config.groups[0].id);
      const groups=variables.partial ? [config.groups[2],config.groups[0]] : config.groups;
      return <><nav className="authored-tabs" role="tablist" aria-label="Status categories">{groups.map(group=><button key={group.id} role="tab" data-status-category={variables.partial && group.id==="one" ? group.id : undefined} aria-selected={active===group.id} onClick={()=>setActive(group.id)}>{group.label}<span>2</span></button>)}</nav><div role="tabpanel">{active}:{variables["hp-id"]}</div></>;
    }` };
  const original = { ...files };
  const readyMessages: Array<{ data: unknown; targetOrigin: string }> = [];
  dom.window.postMessage = ((data: unknown, targetOrigin: string) => { readyMessages.push({ data, targetOrigin }); }) as typeof dom.window.postMessage;
  const api = { worldName: "Preview", variables: { "hp-id": 84 } as Record<string, unknown>, resolveAssetUrl: (ref: string) => ref };
  const result = bundleAndCompile(statusEditor.buildStatusPreviewFiles({ id: "preview", name: "Preview", updatedAt: "saved", files, entryFile: "index.tsx" }, config, templates), () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const root = createRoot(document.getElementById("root")!);
  const render = () => React.act(async () => root.render(React.createElement(result.Component!)));
  const select = (categoryId: string, origin = "https://yumina.test", source: Window | null = dom.window as unknown as Window) => React.act(async () => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source, origin, data: { type: "yumina-status-preview-category", categoryId } }));
  });
  try {
    await render();
    assert.deepEqual(readyMessages, [{ data: { type: "yumina-status-preview-ready" }, targetOrigin: "https://yumina.test" }], "notify the parent only after the category receiver is installed");
    const panel = () => document.querySelector('[role="tabpanel"]')!.textContent;
    assert.equal(panel(), "one:84");
    assert.equal(dom.window.getComputedStyle(document.querySelector('[role="tab"]')!).width, "auto", "custom tabs override the full-width menu button rule");
    await select("two", "https://untrusted.test"); assert.equal(panel(), "one:84");
    await select("two", "https://yumina.test", null); assert.equal(panel(), "one:84");
    await select("two"); assert.equal(panel(), "two:84");
    await select("empty"); assert.equal(panel(), "empty:84");
    await select("missing"); assert.equal(panel(), "empty:84");
    await React.act(async () => (document.querySelector('[role="tab"]') as HTMLButtonElement).click());
    api.variables = { "hp-id": 37 }; await render();
    assert.equal(panel(), "one:37", "value updates preserve direct preview navigation");
    await select("empty"); assert.equal(panel(), "empty:37");
    api.variables = { "hp-id": 37, partial: true }; await render();
    await select("one"); assert.equal(panel(), "one:37", "stable IDs address reordered partial tabs with badges");
    await select("empty"); assert.equal(panel(), "empty:37", "unique direct text ignores badge contents and tab order");
    await select("two"); assert.equal(panel(), "empty:37", "an absent category cannot select a different tab sharing its label");
    assert.deepEqual(files, original);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
test("new VN status sheets separate identity, vitals, resources and signed relationships", () => {
  const config = initialStatusConfig([variable,
    { ...variable, id: "day", name: "Academy Day" },
    { ...variable, id: "gold", name: "Gold" },
    { ...variable, id: "rel-sera", name: "Sera", min: -100, max: 100, defaultValue: 0 }]);
  assert.deepEqual(config.groups.map(group => group.id), ["overview", "vitals", "resources", "relationships"]);
  assert.equal(config.fields[0].group, "vitals");
  assert.equal(config.fields[1].group, "overview");
  assert.equal(config.fields[2].group, "resources");
  assert.equal(config.fields[3].group, "relationships");
  assert.equal(config.fields[3].format, "pips");
  assert.equal(config.fields[3].pipCount, 10);
  assert.equal(config.fields[3].min, -100);
});
test("Visualizations preview bundles the saved custom layout instead of a different stock view", async () => {
  assert.equal(typeof statusEditor.buildStatusPreviewFiles, "function");
  const folder = new URL("../../../../../../interfaces/vn/", import.meta.url);
  const templates = Object.fromEntries(["status-data.ts", "status-view.tsx", "status-sheet.tsx", "status-layout.tsx", "status-gauge.tsx", "status-widgets.tsx"].map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  const layout = 'export default function CustomStatus({variables}){return <div>Saved relationship compass: {variables["hp-id"]}</div>}';
  const root = { id: "root", name: "VN", updatedAt: "saved", entryFile: "index.tsx", files: { ...templates, "status-layout.tsx": layout,
    "index.tsx": "export default function App(){return <div>Main menu</div>}", "styles.ts": "export const styles = `body{color:white}`;" } } as RootComponent;
  const preview = statusEditor.buildStatusPreviewFiles(root, initialStatusConfig([variable]), templates);
  assert.equal(preview.files["status-layout.tsx"], layout);
  const { bundleTSX } = await import("../../studio/lib/tsx-bundler");
  const result = bundleTSX(preview);
  assert.equal(result.error, null);
  assert.ok(result.code?.includes("Saved relationship compass"));
  assert.ok(!result.code?.includes("Main menu"));
  assert.equal(root.files["status-layout.tsx"], layout);
});
test("status preview resolves the saved font and leaves no unresolved font face when a font is absent", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { bundleAndCompile } = await import("../../studio/lib/tsx-bundler");
  const folder = new URL("../../../../../../interfaces/vn/", import.meta.url);
  const templates = Object.fromEntries(["status-data.ts", "status-view.tsx", "status-sheet.tsx", "status-layout.tsx", "status-gauge.tsx", "status-widgets.tsx"].map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  for (const font of ["@asset:card-font", "", null]) {
    const files: Record<string, string> = { ...templates,
      "index.tsx": "export default function App(){return null}",
      "styles.ts": 'export const styles = "@font-face{font-family:VN;src:url(\'__FONT_URL__\')} .vn{font-family:VN,sans-serif}";',
      "status-layout.tsx": 'export default function Layout({variables}){return <p>Saved status: {variables["hp-id"]}</p>}',
    };
    if (font !== null) files["font.ts"] = `export const fontRef = ${JSON.stringify(font)};`;
    const original = { ...files };
    const root = { id: "root", name: "VN", updatedAt: "saved", entryFile: "index.tsx", files } as RootComponent;
    const resolved: string[] = [];
    const result = bundleAndCompile(statusEditor.buildStatusPreviewFiles(root, initialStatusConfig([variable]), templates), () => ({
      variables: { "hp-id": 84 }, worldName: "Preview", resolveAssetUrl: (ref: string) => { resolved.push(ref); return "blob:https://yumina.test/card-font"; },
    }));
    assert.equal(result.error, null, result.error ?? undefined);
    const markup = renderToStaticMarkup(createElement(result.Component!));
    assert.ok(markup.includes("Saved status: 84"));
    assert.ok(!markup.includes("__FONT_URL__"), "the scene must not wait for an unresolved placeholder font");
    assert.deepEqual(resolved, font ? [font] : []);
    if (font) assert.ok(markup.includes("blob:https://yumina.test/card-font"));
    else assert.ok(!markup.includes("@font-face"), "an unset font must use the stylesheet's fallback families");
    assert.deepEqual(root.files, original);
  }
});
test("status configuration binds literal IDs and nested state, clamps bars and preserves negative scales", () => {
  const config = initialStatusConfig([variable]);
  assert.deepEqual(readStatusConfig(writeStatusConfig(config)), config);
  const variables = { "hp-id": 84, stats: { hp: 32, max: 60 }, "a.b": 7 };
  assert.equal(statusValue(variables, "a.b"), 7);
  assert.equal(statusValue(variables, "stats", "hp"), 32);
  assert.equal(statusValue(variables, "stats", "__proto__"), undefined);
  assert.equal(statusValue(variables, "missing"), undefined);
  const field = { ...config.fields[0], variableId: "stats", path: "hp", maxVariableId: "stats", maxPath: "max" };
  assert.equal(statusRange(field, variables).percent, 32 / 60 * 100);
  assert.equal(statusRange(config.fields[0], { "hp-id": 120 }).percent, 100);
  assert.equal(statusRange({ ...config.fields[0], min: -100, max: 100 }, { "hp-id": 0 }).percent, 50);
  assert.equal(statusRange(config.fields[0], {}).value, null);
  assert.deepEqual(statusItems([{ name: "Potion", quantity: 2 }]), [{ name: "Potion", quantity: "2" }]);
});

test("editor rejects executable configuration and excludes internal variables from initial fields", () => {
  assert.throws(() => readStatusConfig('export const statusConfig = (() => { throw new Error("executed") })();'));
  assert.throws(() => readStatusConfig('export const statusConfig = {}; alert("execute");'));
  assert.equal(initialStatusConfig([variable, { ...variable, id: "internal", internal: true }]).fields.length, 1);
});

test("existing card upgrade is idempotent and keeps authored UI, assets and bundle files", () => {
  const folder = new URL("../../../../../../interfaces/vn/", import.meta.url);
  const modern = readFileSync(new URL("index.tsx", folder), "utf8");
  const old = modern.replace('import { StatusSheet } from "./status-sheet";\n', "")
    .replace(/^.*vn-menu-status.*\n/gm, "").replace(/^.*panel === "status".*\n/gm, "")
    .replace('["save", "status"].includes(panel) ? "menu" : ""', 'panel === "save" ? "menu" : ""');
  const root = { id: "root", name: "VN", entryFile: "index.tsx", updatedAt: "before", files: {
    "index.tsx": old + "\n// authored customization", "styles.ts": "export const styles = `custom CSS`;", "sprites.ts": "custom sprites", "_bundles/hud/index.tsx": "custom HUD",
  } } as RootComponent;
  const config = initialStatusConfig([variable]);
  const templates = Object.fromEntries(["status-data.ts", "status-view.tsx", "status-sheet.tsx", "status-gauge.tsx", "status-widgets.tsx"].map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  const updated = installStatusVisualization(root, config, templates);
  assert.deepEqual(installStatusVisualization({ ...root, files: updated }, config, templates), updated);
  for (const name of ["sprites.ts", "_bundles/hud/index.tsx"]) assert.equal(updated[name], root.files[name]);
  assert.ok(updated["styles.ts"].includes('`custom CSS\n'));
  assert.ok(updated["index.tsx"].endsWith("// authored customization"));
  assert.ok(updated["index.tsx"].includes('StatusSheet api={sceneApi}'));
  assert.ok(!root.files["status-config.ts"]);
});

test("all display options round trip, with bounded pip settings and safe defaults", () => {
  const formats = ["value", "bar", "segments", "badges", "inventory", "gauge", "resource", "chips", "pips", "xp-ring", "scene"];
  for (const format of formats) {
    const config = readStatusConfig(`export const statusConfig = ${JSON.stringify({ fields: [{ ...initialStatusConfig([variable]).fields[0], format, gaugeShape: "quarter", pipShape: "diamond", pipCount: 99, levelVariableId: "stats", levelPath: "level", sceneIcon: "field" }] })};`);
    assert.equal(config.fields[0].format, format);
    assert.equal(config.fields[0].gaugeShape, "quarter");
    assert.equal(config.fields[0].pipCount, 20);
    assert.equal(config.fields[0].levelPath, "level");
    assert.deepEqual(readStatusConfig(writeStatusConfig(config)), config);
  }
  const safe = readStatusConfig('export const statusConfig = {"fields":[{"format":"arbitrary","pipCount":-2,"gaugeShape":"invalid","sceneIcon":"invalid"}]};').fields[0];
  assert.equal(safe.format, "value"); assert.equal(safe.pipCount, 1); assert.equal(safe.gaugeShape, "half"); assert.equal(safe.sceneIcon, "auto");
  assert.deepEqual(statusItems([{ name: "Shield", remaining: 1, icon: "◆" }, { name: "Haste", turns: 2 }]), [{ name: "Shield", quantity: undefined, icon: "◆", expiring: true }, { name: "Haste", quantity: undefined, expiring: false }]);
});

test("old saved renderer upgrades immediately without changing settings or authored files", async () => {
  const { upgradeStatusFiles } = await import("./status-visualizations");
  const { legacyStatusTemplates } = await import("@yumina/engine");
  const folder = new URL("../../../../../../interfaces/vn/", import.meta.url);
  const names = ["status-data.ts", "status-view.tsx", "status-gauge.tsx", "status-widgets.tsx"];
  const templates = Object.fromEntries(names.map(name => [name, readFileSync(new URL(name, folder), "utf8")]));
  const files: Record<string, string> = { ...legacyStatusTemplates, "status-config.ts": 'export const statusConfig = {"fields":[]};', "sprites.ts": "authored sprite map", "styles.ts": "authored styles", "_bundles/hud/index.tsx": "overlay" };
  const { hashRootFiles, isCompiledValid, COMPILED_FORMAT_VERSION } = await import("../../studio/lib/compiled-format");
  const compiled = { code: "old bundled renderer", filesHash: hashRootFiles("index.tsx", files), compilerVersion: COMPILED_FORMAT_VERSION };
  assert.equal(isCompiledValid(compiled, "index.tsx", files), true);
  const upgraded = upgradeStatusFiles(files, templates);
  assert.equal(isCompiledValid(compiled, "index.tsx", upgraded), false);
  for (const name of names) assert.equal(upgraded[name], templates[name]);
  for (const name of ["status-config.ts", "sprites.ts", "styles.ts", "_bundles/hud/index.tsx"]) assert.equal(upgraded[name], files[name]);
  assert.equal(upgradeStatusFiles(upgraded, templates), upgraded);
  assert.notEqual(upgraded, files); assert.equal(files["status-view.tsx"], legacyStatusTemplates["status-view.tsx"]);
  const customView = { ...files, "status-view.tsx": "custom view" };
  const updatedView = upgradeStatusFiles(customView, templates);
  assert.equal(updatedView["status-view.tsx"], "custom view");
  assert.equal(updatedView["status-data.ts"], templates["status-data.ts"]);
  // Authored helper contracts or colliding widget filenames stay untouched.
  for (const custom of ([{ "status-data.ts": "custom data" }, { "status-gauge.tsx": "custom gauge" }, { "status-widgets.tsx": "custom widgets" }] as Record<string, string>[])) {
    const authored = { ...files, ...custom };
    assert.equal(upgradeStatusFiles(authored, templates), authored);
  }
});

test("status categories preserve legacy defaults, custom labels, unknown groups, and bounded definitions", () => {
  const legacy = normalizeStatusConfig({ fields: [{ id: "hp", label: "Health", group: "overview" }] });
  assert.deepEqual(legacy.groups, defaultStatusCategories);

  const custom = normalizeStatusConfig({
    groups: [
      { id: "stats", label: "Stats" },
      { id: "stats", label: "Duplicate" },
      { id: "averylong".repeat(20), label: "x".repeat(120) },
    ],
    fields: [{ id: "luck", group: "luck", label: "Luck" }],
  });
  assert.equal(custom.groups[0].label, "Stats");
  assert.equal(custom.groups.filter(group => group.id === "stats").length, 1);
  assert.ok(custom.groups.some(group => group.id === "luck"));
  assert.ok(custom.groups.every(group => group.id.length <= 64 && group.label.length <= 80));
  assert.equal(custom.fields[0].group, "luck");
});
