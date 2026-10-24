import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnErrorLayoutFiles } from "./vn-error-layout-upgrade";

const read = (name: string) => readFileSync(new URL(`../../../../../interfaces/vn/${name}`, import.meta.url), "utf8");
const currentRoot = read("index.tsx");
// Reconstruct the stylesheet that shipped with this older error-layout upgrade.
const currentStyles = read("styles.ts")
  .replace(/^\.vn-reply-ready\{.*\n/m, "")
  .replace(/^\.vn-dialogue:has\(\.vn-reply-ready\).*\n/m, "");
const legacyHook = readFileSync(new URL('./test-fixtures/vn-error-layout-legacy-hook.txt', import.meta.url), "utf8").trimEnd();
const oldRoot = currentRoot
  .replace(/ {4}function layout\(\) \{[\s\S]*?(?=\n {4}const observer =)/, legacyHook)
  .replace('.vn-dialogue,.vn-progress,.vn-choices,.vn-controls,.vn-error', '.vn-dialogue,.vn-choices,.vn-controls')
  .replace('hidden, spriteLimit, error, JSON.stringify(api.vnTextPreferences)', 'hidden, spriteLimit, JSON.stringify(api.vnTextPreferences)');
const oldStyles = currentStyles
  .replace('bottom:calc(85px + var(--error-space,0px))', 'bottom:85px')
  .replace('bottom:calc(7.8704vh + var(--error-space,0px))', 'bottom:7.8704vh')
  .replace('bottom:calc(7% + var(--error-space,0px))', 'bottom:7%')
  .replace('inset:auto 20px calc(var(--reader-bottom) + var(--error-space,0px))', 'inset:auto 20px var(--reader-bottom)')
  .replace('var(--reader-top) - var(--reader-bottom) - var(--error-space,0px)', 'var(--reader-top) - var(--reader-bottom)')
  .replace('inset:auto 5% calc(16px + var(--error-space,0px))', 'inset:auto 5% 16px')
  .replace('100% - 92px - var(--error-space,0px)', '100% - 92px')
  .replace('max-height:min(40vh,var(--error-max-height,40vh))', 'max-height:40vh')
  .replace(/\/\* Keep a long passage scrollable above wrapped recovery errors and the toolbar\. \*\/\n[^\n]+\n[^\n]+\n/, '');

test("saved stock VN readers reserve error space without replacing authored files or handlers", () => {
  const root = oldRoot.replace('    if (scrollPassage()) return;', '    if (customReader()) return;');
  const styles = oldStyles.replace('`;', '.my-authored-style{color:gold}\n`;');
  const files = { 'index.tsx': root, 'styles.ts': styles, 'sprites.ts': 'authored art', 'status-layout.tsx': 'authored layout' };
  const next = upgradeVnErrorLayoutFiles(files);
  assert.notEqual(next, files);
  assert.match(next['index.tsx'], /const errorBanner =/);
  assert.match(next['index.tsx'], /if \(customReader\(\)\) return/);
  assert.match(next['styles.ts'], /\.my-authored-style\{color:gold\}/);
  assert.match(next['styles.ts'], /\.vn:has\(>\.vn-error\) \.vn-text/);
  assert.equal(next['sprites.ts'], files['sprites.ts']);
  assert.equal(next['status-layout.tsx'], files['status-layout.tsx']);
  assert.equal(files['index.tsx'], root);
  assert.equal(upgradeVnErrorLayoutFiles(next), next);
});

test("nested stock readers are upgraded beside their own styles", () => {
  const files = { 'ui/story.tsx': oldRoot, 'ui/styles.ts': oldStyles };
  const next = upgradeVnErrorLayoutFiles(files);
  assert.equal(next['ui/story.tsx'], currentRoot);
  assert.equal(next['ui/styles.ts'], currentStyles);
  assert.equal(next['styles.ts'], undefined);
});

test("custom layout hooks, custom anchors, missing styles and already updated readers remain unchanged", () => {
  const cases: Record<string, string>[] = [
    { 'index.tsx': oldRoot.replace('    function layout() {', '    function customLayout() {'), 'styles.ts': oldStyles },
    { 'index.tsx': oldRoot, 'styles.ts': oldStyles.replace('bottom:85px;', 'bottom:99px;') },
    { 'index.tsx': oldRoot },
    { 'index.tsx': 'export default function Chat() {}', 'styles.ts': oldStyles },
    { 'index.tsx': currentRoot, 'styles.ts': currentStyles },
  ];
  for (const files of cases) assert.equal(upgradeVnErrorLayoutFiles(files), files);
});

test("styles with extra authored exports are preserved instead of appending into another literal", () => {
  const files = { 'index.tsx': oldRoot, 'styles.ts': oldStyles + 'export const authored = `do not edit`;\n' };
  assert.equal(upgradeVnErrorLayoutFiles(files), files);
});

test("readers importing custom styles leave the unused sibling stylesheet alone", () => {
  const files = { 'index.tsx': oldRoot.replace('from "./styles"', 'from "../shared/styles"'), 'styles.ts': oldStyles };
  assert.equal(upgradeVnErrorLayoutFiles(files), files);
});

test("every stock reader sharing the same stylesheet is upgraded", () => {
  const files = { 'index.tsx': oldRoot, '__user-root.tsx': oldRoot, 'styles.ts': oldStyles };
  const next = upgradeVnErrorLayoutFiles(files);
  assert.equal(next['index.tsx'], currentRoot);
  assert.equal(next['__user-root.tsx'], currentRoot);
  assert.equal(next['styles.ts'], currentStyles);
  assert.equal(upgradeVnErrorLayoutFiles(next), next);
});
