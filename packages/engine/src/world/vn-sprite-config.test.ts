import { describe, it, expect } from 'vitest';
import * as assets from './vn-assets.js';
const source = '// my custom prefix\nexport const sprites = { Alice: { normal: "@asset:a", curious: "@asset:b" } };\nexport function myCustomResolver() { return 42; }\n';
describe('card sprite catalogs', () => {
 it('infers custom legacy emotions and preserves surrounding authored code', () => {
  const config=assets.readVnSpriteConfig(source);
  expect(config.types).toEqual({normal:'Normal'});
  expect(config.emotions.curious).toBe('Curious');
  const updated=assets.assignVnSprite(assets.addVnSpriteOption(source,'types','Battle Wear'),'Alice','battle-wear','curious','@asset:c');
  expect(assets.readVnSpriteSets(updated)['battle-wear']).toEqual({Alice:{curious:'@asset:c'}});
  expect(assets.readVnAssetMap(updated,'sprites')).toEqual(assets.readVnAssetMap(source,'sprites'));
  expect(updated).toContain('export function myCustomResolver() { return 42; }');
 });
 it('renames labels without changing stable tag ids and removes only selected slots', () => {
  let updated=assets.addVnSpriteOption(source,'types','Battle Wear');
  updated=assets.assignVnSprite(updated,'Alice','battle-wear','curious','@asset:c');
  updated=assets.renameVnSpriteOption(updated,'types','battle-wear','Battle Armor');
  expect(assets.readVnSpriteConfig(updated).types['battle-wear']).toBe('Battle Armor');
  updated=assets.removeVnSpriteOption(updated,'types','battle-wear');
  expect(assets.vnSpriteRows(updated)).toHaveLength(2);
  expect(assets.readVnAssetMap(updated,'sprites').Alice).toEqual({normal:'@asset:a',curious:'@asset:b'});
  expect(()=>assets.removeVnSpriteOption(updated,'emotions','normal')).toThrow();
 });
 it('supports custom types beyond seven while retaining the thirty-emotion vocabulary guard', () => {
  let updated=source;
  for(let i=0;i<32;i++)updated=assets.addVnSpriteOption(updated,'types',`Outfit ${i}`);
  expect(Object.keys(assets.readVnSpriteConfig(updated).types)).toHaveLength(33);
  for(let i=0;i<23;i++)updated=assets.addVnSpriteOption(updated,'emotions',`Mood ${i}`);
  expect(Object.keys(assets.readVnSpriteConfig(updated).emotions)).toHaveLength(30);
  expect(()=>assets.addVnSpriteOption(updated,'emotions','One too many')).toThrow(/30/);
  expect(()=>assets.assignVnSprite(updated,'Alice','unknown','normal','@asset:c')).toThrow();
 });
 it('rejects executable config and preserves independent cards', () => {
  expect(()=>assets.readVnSpriteConfig(source+'\nexport const spriteConfig = createConfig();')).toThrow();
  const updated=assets.addVnSpriteOption(source,'emotions','Embarrassed');
  expect(assets.readVnSpriteConfig(updated).emotions.embarrassed).toBe('Embarrassed');
  expect(assets.readVnSpriteConfig(source).emotions.embarrassed).toBeUndefined();
 });
});
it('retains catalog exports when refreshing a template that did not previously declare them',()=>{
 const updated=assets.addVnSpriteOption(source,'types','Battle');
 const typed=assets.assignVnSprite(updated,'Alice','battle','normal','@asset:battle');
 const refreshed=assets.preserveVnAssetConfiguration(typed,'export const sprites = {};\n// template behavior\n','sprites');
 expect(assets.readVnSpriteConfig(refreshed).types.battle).toBe('Battle');
 expect(assets.readVnSpriteSets(refreshed).battle).toEqual({Alice:{normal:'@asset:battle'}});
});
it('accepts larger type catalogs through direct saves and keeps legacy maps readable',()=>{
 let config=assets.readVnSpriteConfig(source);
 for(let i=0;i<7;i++)config.types[`extra-${i}`]=`Extra ${i}`;
 const oversized=source+'\nexport const spriteConfig = '+JSON.stringify(config)+';';
 expect(()=>assets.assertVnSpriteCatalogUpdate(source,oversized)).not.toThrow();
 expect(()=>assets.assertVnSpriteCatalogUpdate(oversized,oversized)).not.toThrow();
});
it('enforces inferred catalog limits when a save omits or deletes spriteConfig',()=>{
 const moods=Object.fromEntries(Array.from({length:31},(_,i)=>[`mood-${i}`,'@asset:a']));
 const oversized='export const sprites = '+JSON.stringify({Alice:moods})+';';
 expect(()=>assets.assertVnSpriteCatalogUpdate(source,oversized)).toThrow(/30/);
 const types=Object.fromEntries(Array.from({length:7},(_,i)=>[`type-${i}`,{Alice:{normal:'@asset:a'}}]));
 expect(()=>assets.assertVnSpriteCatalogUpdate(source,source+'\nexport const spriteTypes = '+JSON.stringify(types)+';')).not.toThrow();
 expect(()=>assets.assertVnSpriteCatalogUpdate(source,'export const sprites = myCustomCode();')).not.toThrow();
});
it('preserves exact legacy IDs and disambiguates labels without changing images',()=>{
 const legacy='export const sprites = {Kei:{Happy:"@asset:h",Curious:"@asset:c","foo-bar":"@asset:f","foo_bar":"@asset:g"}};';
 const config=assets.readVnSpriteConfig(legacy);
 expect(new Set(Object.values(config.emotions)).size).toBe(Object.keys(config.emotions).length);
 const updated=assets.assignVnSprite(assets.writeVnSpriteConfig(legacy,config),'Kei','normal','Curious','@asset:new');
 expect(assets.readVnAssetMap(updated,'sprites').Kei).toEqual({Happy:'@asset:h',Curious:'@asset:new','foo-bar':'@asset:f',foo_bar:'@asset:g'});
});
it('rejects unsafe manually supplied type IDs',()=>{
 const config=assets.readVnSpriteConfig(source);
 Object.defineProperty(config.types,'__proto__',{value:'Danger',enumerable:true});
 expect(()=>assets.writeVnSpriteConfig(source,config)).toThrow();
});

it('stores clothing per character and type and preserves it through helper refreshes',()=>{
 let updated=assets.addVnSpriteOption(source,'types','Uniform');
 updated=assets.writeVnSpriteWardrobeDescription(updated,'Alice','uniform','A navy jacket and white shirt.');
 updated=assets.writeVnSpriteWardrobeDescription(updated,'alice','normal','A loose green shirt.');
 expect(assets.readVnSpriteWardrobeDescriptions(updated)).toEqual({Alice:{uniform:'A navy jacket and white shirt.',normal:'A loose green shirt.'}});
 const refreshed=assets.preserveVnAssetConfiguration(updated,'export const sprites = {};\n// refreshed helper\n','sprites');
 expect(assets.readVnSpriteWardrobeDescriptions(refreshed)).toEqual(assets.readVnSpriteWardrobeDescriptions(updated));
 const removed=assets.removeVnSpriteOption(updated,'types','uniform');
 expect(assets.readVnSpriteWardrobeDescriptions(removed)).toEqual({Alice:{normal:'A loose green shirt.'}});
 expect(()=>assets.writeVnSpriteWardrobeDescription(updated,'Alice','unknown','A coat.')).toThrow(/wardrobe/i);
 expect(updated).toContain('export function myCustomResolver() { return 42; }');
});

it('derives each inventory from current entries, empty wardrobes, and emotion assignments',()=>{
 const entries=[{name:'NPC: Alice',role:'character',tags:[]}] as any;
 const before=assets.readVnSpriteInventory(source,entries);
 expect(before.characters).toEqual(['Alice']);
 const current=source+'\nexport const spriteTypes = {festival:{alice:{delighted:"@asset:party"},Bob:{}}};';
 const after=assets.readVnSpriteInventory(current,[...entries,{name:'Cara',role:'character',tags:[]}]);
 expect(after.characters).toEqual(['Alice','Cara','Bob']);
 expect(after.config.types.festival).toBe('Festival');
 expect(after.config.emotions.delighted).toBe('Delighted');
 expect(before.config.types.festival).toBeUndefined();
});
