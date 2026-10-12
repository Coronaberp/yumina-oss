import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCharacterShowcase, writeCharacterShowcaseCss, type CharacterShowcase } from "../world/character-showcase.js";
import type { RootComponent, WorldEntry } from "../types/index.js";

const viewer = readFileSync(new URL("../../../../interfaces/vn/character-viewer.tsx", import.meta.url), "utf8");
const root = { id:"root",name:"VN",interfaceId:"vn",entryFile:"index.tsx",files:{"index.tsx":"authored entry","character-viewer.tsx":viewer,"sprites.ts":"authored sprites","status-config.ts":"authored stats"} } as RootComponent;
const entries = [{id:"sera",name:"Sera",role:"character"},{id:"ryu",name:"Ryu",role:"character"},{id:"lore",name:"Secret",role:"lore"}] as WorldEntry[];

test("shared showcase CSS and per-character overrides round trip without disturbing authored files", () => {
  const shared = ':scope {background:#182d34;}\n.vn-character-sprite img {filter:drop-shadow(0 0 12px cyan);}';
  const first = writeCharacterShowcaseCss(root,entries,shared);
  const second = writeCharacterShowcaseCss(first,entries,':scope {border-color:pink;}','sera');
  const config: CharacterShowcase = readCharacterShowcase(second.files['character-showcase.ts']);
  assert.deepEqual(config,{css:shared,characters:{sera:':scope {border-color:pink;}'}});
  assert.equal(second.files['index.tsx'],root.files['index.tsx']); assert.equal(second.files['sprites.ts'],root.files['sprites.ts']);assert.equal(second.files['status-config.ts'],root.files['status-config.ts']);
  assert.match(second.files['character-viewer.tsx']!,/showcaseStylesFor\(viewer.target.id\)/);
  assert.ok(!root.files['character-showcase.ts'],'input root is not mutated');
  assert.deepEqual(readCharacterShowcase(writeCharacterShowcaseCss(second,entries,'','sera').files['character-showcase.ts']),{css:shared,characters:{}});
});

test("showcase writer rejects unknown/noncharacter targets, executable config and unsupported viewers", () => {
  assert.throws(()=>writeCharacterShowcaseCss(root,entries,'body {}','missing'),/character/i);
  assert.throws(()=>writeCharacterShowcaseCss(root,entries,'body {}','lore'),/character/i);
  assert.throws(()=>readCharacterShowcase('export const characterShowcase = (()=>{throw new Error("executed")})();'),/literal/i);
  assert.throws(()=>writeCharacterShowcaseCss({...root,files:{...root.files,'character-viewer.tsx':'authored viewer'}},entries,'body {}'),/viewer/i);
  assert.throws(()=>writeCharacterShowcaseCss(root,entries,'x'.repeat(30001)),/30,000/);
});

test("older viewers receive only a style import and mount; authored config runtime is retained", () => {
  const legacy = viewer.replace('import { showcaseStylesFor } from "./character-showcase";\n', '').replace('    <style>{showcaseStylesFor(viewer.target.id)}</style>\n', '');
  const before = { ...root, compiled: { code: 'old', filesHash: 'old', compilerVersion: 1 }, files: { ...root.files, 'character-viewer.tsx': legacy } };
  const updated = writeCharacterShowcaseCss(before, entries, ':scope {color:white;}');
  assert.equal(updated.files['character-viewer.tsx'], 'import { showcaseStylesFor } from "./character-showcase";\n' + legacy.replace('<div className="vn-character-card">','<style>{showcaseStylesFor(viewer.target.id)}</style>\n    <div className="vn-character-card">'));
  assert.equal(updated.compiled, undefined);
  const source = updated.files['character-showcase.ts']! + '\n// Authored extension must survive';
  const edited = writeCharacterShowcaseCss({ ...updated, files: { ...updated.files, 'character-showcase.ts':source } }, entries, ':scope {color:tan;}');
  assert.ok(edited.files['character-showcase.ts']!.endsWith('// Authored extension must survive'));
  assert.equal(edited.files['character-viewer.tsx'], updated.files['character-viewer.tsx']);
});
