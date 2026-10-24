import assert from "node:assert/strict";
import test from "node:test";
import type { RootComponent, Variable } from "@yumina/engine";
import { initialStatusConfig } from "./status-visualizations";
import { MAX_STATUS_DESIGN_BYTES, parseStatusDesign, prepareStatusDesign, statusDesignInstructions } from "./status-design-import";

const code = 'export default function StatusLayout({config,variables,preview}:any){return <div>{variables["hp"]}</div>}';
const variable = { id: "hp", name: "Health", type: "number", defaultValue: 0, min: 0, max: 100, description: "Live health" } as Variable;
const config = initialStatusConfig([variable]);
const root: RootComponent = { id: "root", name: "VN", entryFile: "index.tsx", updatedAt: "saved", compiled: { code: "old", filesHash: "old", compilerVersion: 1 }, files: {
  "index.tsx": "authored menu", "status-sheet.tsx": 'import StatusLayout from "./status-layout";', "status-layout.tsx": "original design", "status-config.ts": "original settings", "sprites.ts": "custom art",
} };

test("external design instructions include every complete variable and the current config without changing data", () => {
  const variables = [variable, { ...variable, id: "engine-state", internal: true, defaultValue: { nested: false }, extension: "kept" } as unknown as Variable];
  const before = JSON.stringify({ variables, root, config });
  const brief = statusDesignInstructions("My VN", variables, config, root);
  const payload = JSON.parse(brief.split("```json\n")[1].split("\n```")[0]);
  assert.deepEqual(payload.variables, variables);
  assert.deepEqual(payload.statusConfig, config);
  assert.equal(payload.currentLayoutCode, root.files["status-layout.tsx"]);
  for (const term of ["config.groups", "config.fields", "data-status-category", "variables", "defaultValue", "320", "Back", "JSON", "custom editing"]) assert.ok(brief.includes(term), term);
  assert.equal(JSON.stringify({ variables, root, config }), before);
});

test("import accepts a whole TSX file, one code fence, and versioned JSON", () => {
  for (const input of [code, "```typescript\n" + code + "\n```", JSON.stringify({ format: "yumina-status-design", version: 1, layoutCode: code })]) assert.equal(parseStatusDesign(input), code);
  for (const input of ["", "<html><script>alert(1)</script></html>", "{}", JSON.stringify({ format: "yumina-status-design", version: 2, layoutCode: code }), "x".repeat(MAX_STATUS_DESIGN_BYTES + 1), 'export default function Layout(){return <broken>}', 'import X from "unknown-package";\n' + code, 'export default { title: "Not a component" };']) assert.throws(() => parseStatusDesign(input));
  assert.equal(parseStatusDesign('import { statusValue } from "./status-data";\n' + code).includes("statusValue"), true);
});

test("candidate preparation changes exactly the layout in a clone and never executes it", () => {
  const before = JSON.stringify(root);
  const candidate = prepareStatusDesign(root, code + ';globalThis.__importExecuted=true;');
  assert.equal((globalThis as Record<string, unknown>).__importExecuted, undefined);
  assert.equal(candidate.compiled, undefined);
  assert.equal(candidate.files["status-layout.tsx"].includes("__importExecuted"), true);
  for (const name of Object.keys(root.files).filter(name => name !== "status-layout.tsx")) assert.equal(candidate.files[name], root.files[name]);
  assert.equal(JSON.stringify(root), before);
  assert.throws(() => prepareStatusDesign({ ...root, files: { ...root.files, "status-sheet.tsx": "unconnected sheet" } }, code));
});

test("candidate imports must resolve helpers on the actual card instead of preview fallback templates", () => {
  const input = 'import { StatusWidget } from "./status-widgets";\n' + code;
  assert.throws(() => prepareStatusDesign(root, input), /missing.*status-widgets/i);
  const complete = { ...root, files: { ...root.files, "status-widgets.tsx": "export const StatusWidget=()=>null;" } };
  assert.equal(prepareStatusDesign(complete, input).files["status-layout.tsx"], input);
  assert.equal(prepareStatusDesign(complete, input.replace('./status-widgets', './status-widgets.tsx')).files["status-layout.tsx"].includes('./status-widgets.tsx'), true);
  assert.equal(root.files["status-widgets.tsx"], undefined);
});
