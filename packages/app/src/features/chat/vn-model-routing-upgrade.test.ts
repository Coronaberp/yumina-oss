import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnModelRoutingFiles } from "./vn-model-routing-upgrade";
const read = (name: string) => readFileSync(new URL(`../../../../../interfaces/vn/${name}`, import.meta.url), "utf8");
const current = read("index.tsx"), helper = read("model-routing-details.tsx");
const old = current.replace('import { ModelRoutingDetails } from "./model-routing-details";\n', "")
  .replace('function Menu({ api, currentMessage, onClose', 'function Menu({ api, onClose')
  .replace('            <ModelRoutingDetails selectedModel={api.selectedModel} message={currentMessage} />\n', "")
  .replace('<Menu api={api} currentMessage={currentMessage} onClose=', '<Menu api={api} onClose=');

test("known VN settings gain model details without replacing authored content or artwork", () => {
  const input = { "ui/index.tsx": old + "// creator integration\n", "sprites.ts": "creator sprites", "ui/styles.ts": "creator styles", "story.ts": "creator story" };
  const next = upgradeVnModelRoutingFiles(input, helper);
  assert.notEqual(next, input);
  const importLine = 'import { ModelRoutingDetails } from "./model-routing-details";\n';
  assert.equal(next["ui/index.tsx"].split(importLine).length, 2);
  assert.equal(next["ui/index.tsx"].replace(importLine, ""), (current + "// creator integration\n").replace(importLine, ""));
  assert.equal(next["ui/model-routing-details.tsx"], helper);
  for (const key of ["sprites.ts", "ui/styles.ts", "story.ts"]) assert.equal(next[key], input[key as keyof typeof input]);
  assert.equal(input["ui/index.tsx"], old + "// creator integration\n", "input is immutable");
  assert.equal(upgradeVnModelRoutingFiles(next, helper), next, "upgrade is idempotent");
});

test("custom settings, custom helper modules and partial upgrades stay untouched", () => {
  const cases: Record<string, string>[] = [
    { "index.tsx": old.replace('function Menu({ api, onClose', 'function CustomMenu({ api, onClose') },
    { "index.tsx": old.replace('Choose AI model', 'My own model controls') },
    { "index.tsx": old.replace('<Menu api={api} onClose=', '<Menu api={customApi} onClose=') },
    { "index.tsx": old.replace('className="vn-stage"', 'className="creator-stage"') },
    { "index.tsx": old, "model-routing-details.tsx": "creator custom model panel" },
    { "index.tsx": current.replace('<Menu api={api} currentMessage={currentMessage} onClose=', '<Menu api={api} onClose=') },
  ];
  for (const files of cases) assert.equal(upgradeVnModelRoutingFiles(files, helper), files);
});
