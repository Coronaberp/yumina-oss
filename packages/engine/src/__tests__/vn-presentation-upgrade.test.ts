import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeVnPresentationFiles } from '../world/vn-presentation-upgrade.js';
import { readVnAssetMap, readVnNpcDefaults, readVnNpcSpritePools, readVnNpcDefaultSpritePools, readVnOpeningScenes } from '../world/vn-assets.js';

const folder = new URL('../../../../interfaces/vn/', import.meta.url);
const template = Object.fromEntries(['sprites.ts', 'scenes.ts', 'status-config.ts', 'status-layout.tsx', 'character-showcase.ts', 'portraits.ts', 'index.tsx'].map(file => [file, readFileSync(new URL(file, folder), 'utf8')]));
const saved = {
  'sprites.ts': `export const sprites = { Maeve: {normal: '@asset:maeve', smug: '@asset:smug'} };
export const npcSprites = {male: {clerk: '@asset:clerk'}, female: {}};
export const npcDefaults = {"disabled":false,"mode":"b"};
export const npcDefaultSpritesA = {male: {figure: '@asset:a'}, female: {}};
export const npcDefaultSpritesB = {male: {knight: '@asset:b'}, female: {}};
export function sceneSprites(){ return 'old helper'; }`,
  'scenes.ts': `export const scenes = {default: '@asset:bg', courtyard: {day: '@asset:day'}};
export const openingScenes = {greeting: {opening: {day: '@asset:opening'}}};
export function backgroundFor(){ return 'old helper'; }`,
  'status-config.ts': 'export const statusConfig = {fields:[{id:"affinity",variableId:"rel-maeve"}]};',
  'status-layout.tsx': 'export default function CustomStatus(){ return <div>Authored layout</div>; }',
  'character-showcase.ts': 'export const characterShowcase = {css:".vn-character-card{color:red}",characters:{}};',
  'portraits.ts': 'export const npcPortraits = {male:"@asset:portrait",female:"@asset:female"};',
  'vn-asset-order.json': '{"sprites":["Maeve"]}',
  'custom.ts': 'export const custom = true;',
};

test('reapplying VN keeps uploaded character and NPC art while refreshing sprite helpers', () => {
  const files = mergeVnPresentationFiles(saved, template);
  assert.deepEqual(readVnAssetMap(files['sprites.ts']!, 'sprites'), readVnAssetMap(saved['sprites.ts'], 'sprites'));
  assert.deepEqual(readVnNpcSpritePools(files['sprites.ts']!), readVnNpcSpritePools(saved['sprites.ts']));
  assert.deepEqual(readVnNpcDefaults(files['sprites.ts']!), {disabled:false, mode:'b'});
  for (const mode of ['a', 'b'] as const) assert.deepEqual(readVnNpcDefaultSpritePools(files['sprites.ts']!, mode), readVnNpcDefaultSpritePools(saved['sprites.ts'], mode));
  assert.ok(files['sprites.ts']!.includes('function playerNpcSpriteSelection'));
  assert.ok(!files['sprites.ts']!.includes('old helper'));
});

test('reapplying VN keeps global and greeting backgrounds with the current resolver', () => {
  const files = mergeVnPresentationFiles(saved, template);
  assert.deepEqual(readVnAssetMap(files['scenes.ts']!, 'backgrounds'), readVnAssetMap(saved['scenes.ts'], 'backgrounds'));
  assert.deepEqual(readVnOpeningScenes(files['scenes.ts']!), readVnOpeningScenes(saved['scenes.ts']));
  assert.ok(files['scenes.ts']!.includes('stateSnapshot?.activeGreetingId'));
});

test('reapplying VN keeps status bindings, authored layout, showcase, portraits and extra files', () => {
  const files = mergeVnPresentationFiles(saved, template);
  for (const file of ['status-config.ts', 'status-layout.tsx', 'character-showcase.ts', 'portraits.ts', 'vn-asset-order.json', 'custom.ts']) assert.equal(files[file], saved[file as keyof typeof saved]);
  assert.equal(files['index.tsx'], template['index.tsx']);
  assert.deepEqual(mergeVnPresentationFiles(files, template), files, 'repeated applies retain the same configuration');
});

test('a new VN keeps template defaults and missing legacy settings gain current defaults', () => {
  assert.deepEqual(mergeVnPresentationFiles({}, template), template);
  const files = mergeVnPresentationFiles({'sprites.ts': 'export const sprites = {Maeve: "@asset:maeve"};'}, template);
  assert.deepEqual(readVnAssetMap(files['sprites.ts']!, 'sprites'), {Maeve:'@asset:maeve'});
  assert.deepEqual(readVnNpcDefaults(files['sprites.ts']!), readVnNpcDefaults(template['sprites.ts']!));
});

test('custom executable asset maps fail before a card can be overwritten', () => {
  assert.throws(() => mergeVnPresentationFiles({'sprites.ts': 'export const sprites = customSpriteLoader();'}, template), /sprites\.ts.*custom code/);
  assert.throws(() => mergeVnPresentationFiles({'scenes.ts': 'export const scenes = {}\nexport const openingScenes = loadOpenings();'}, template), /scenes\.ts/);
});
