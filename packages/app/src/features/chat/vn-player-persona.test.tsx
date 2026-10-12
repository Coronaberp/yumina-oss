import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";
import { upgradePersonaRoot, type RootComponent } from "@yumina/engine";

test("VN displays the persona name while preserving token attribution and the persona portrait", () => {
  const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
  const files = Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]));
  files['probe.tsx'] = `import { playerText } from './player'; import { messagePassages } from './passages';
    export default function Probe() { const api = { entries: [], user: { name: 'Robin', avatar: 'robin.png' } };
      const lines = [...messagePassages(api, { content: '[SPEAKER:{{user}}:normal] "I will try."' }), ...messagePassages(api, { content: '[speaker:robin] \"I will try again.\"' })];
      return <pre>{JSON.stringify({ text: playerText("Evelia offers {{user}} a seat. {{user}}'s coat is blue.", api.user.name), lines })}</pre>; }`;
  const result = bundleAndCompile({ files, entryFile: 'probe.tsx' });
  assert.equal(result.error, null);
  const html = renderToStaticMarkup(createElement(result.Component!));
  assert.match(html, /Evelia offers Robin a seat\. Robin&#x27;s coat is blue\./);
  assert.ok(html.includes('Robin (You)'));
  assert.ok(html.includes('robin.png'));
  assert.ok(!html.includes('NPC'));
});

test("saved VN files receive the named-persona renderer without rewriting the saved card", () => {
  const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
  const files = Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]));
  files['player.ts'] = 'export function playerText(text: string): string { return text.replace(/\\{\\{user\\}\\}/g, "you"); }';
  const original: RootComponent = { id: 'legacy', name: 'VN', interfaceId: 'vn', entryFile: 'index.tsx', files, compiled: { code: 'old-cache', filesHash: 'old', compilerVersion: 1 }, updatedAt: '' };
  const upgraded = upgradePersonaRoot(original);
  assert.equal(original.files['player.ts'].includes('"you"'), true);
  assert.equal(upgraded.compiled, undefined);
  const probe = { ...upgraded.files, 'probe.tsx': `import { playerText } from './player'; export default function Probe() { return <p>{playerText("The guard greets {{user}}.", "Robin")}</p>; }` };
  const compiled = bundleAndCompile({ files: probe, entryFile: 'probe.tsx' });
  assert.equal(compiled.error, null);
  assert.equal(renderToStaticMarkup(createElement(compiled.Component!)), '<p>The guard greets Robin.</p>');
});
