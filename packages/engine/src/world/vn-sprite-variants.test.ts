import { describe, it, expect } from 'vitest';
import * as assets from './vn-assets.js';

const original = '// custom prefix\nexport const sprites = {Alice:{normal:"@asset:base",happy:"@asset:happy"}};\nexport function authoredHelper() { return 123; }\n';
const outfit = () => assets.addVnSpriteVariant(assets.addVnSpriteOption(original,'types','Uniform'),'uniform','PT Kit');

describe('optional outfit variants', () => {
  it('isolates art and descriptions across types, variants and characters', () => {
    let source = outfit();
    source = assets.assignVnSprite(source,'Alice','uniform','happy','@asset:pt','pt-kit');
    source = assets.assignVnSprite(source,'Bob','uniform','normal','@asset:bob');
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','A navy blazer.');
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','A white PT shirt.','pt-kit');
    expect(assets.readVnSpriteVariants(source)).toEqual({uniform:{'pt-kit':'PT Kit'}});
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','pt-kit')).toEqual({expressions:{happy:'@asset:pt'},description:'A white PT shirt.',defaultEmotion:'happy'});
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform')).toEqual({expressions:{},description:'A navy blazer.',defaultEmotion:undefined});
    expect(assets.readVnSpriteOutfit(source,'Bob','uniform','pt-kit').expressions).toEqual({});
    expect(assets.readVnAssetMap(source,'sprites')).toEqual(assets.readVnAssetMap(original,'sprites'));
    expect(source).toContain('export function authoredHelper() { return 123; }');
  });

  it('derives sparse expression choices only from the exact outfit and never borrows clothing', () => {
    let source = outfit();
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','A navy blazer.');
    source = assets.assignVnSprite(source,'Alice','uniform','sad','@asset:sad','pt-kit');
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','pt-kit')).toEqual({expressions:{sad:'@asset:sad'},description:'',defaultEmotion:'sad'});
    expect(assets.readVnSpriteOutfit(source,'Alice').defaultEmotion).toBe('normal');
    expect(assets.vnSpriteRows(source).filter(row=>row.spriteVariant)).toEqual([{name:'Alice',variant:'sad',assetRef:'@asset:sad',spriteType:'uniform',spriteVariant:'pt-kit'}]);
  });

  it('keeps variant labels and clothing when the last image is removed', () => {
    let source = assets.assignVnSprite(outfit(),'Alice','uniform','normal','@asset:pt','pt-kit');
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','A white PT shirt.','pt-kit');
    source = assets.removeVnSprite(source,'Alice','uniform','normal','pt-kit');
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','pt-kit').expressions).toEqual({});
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','pt-kit').description).toBe('A white PT shirt.');
    expect(assets.readVnSpriteVariants(source).uniform?.['pt-kit']).toBe('PT Kit');
  });

  it('renames stable IDs and removes only the selected variant data', () => {
    let source = assets.assignVnSprite(outfit(),'Alice','uniform','normal','@asset:pt','pt-kit');
    source = assets.addVnSpriteVariant(source,'uniform','Formal');
    source = assets.assignVnSprite(source,'Alice','uniform','normal','@asset:formal','formal');
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','PT clothing.','pt-kit');
    source = assets.renameVnSpriteVariant(source,'uniform','pt-kit','Sports Kit');
    expect(assets.readVnSpriteVariants(source).uniform?.['pt-kit']).toBe('Sports Kit');
    source = assets.removeVnSpriteVariant(source,'uniform','pt-kit');
    expect(assets.readVnSpriteVariants(source).uniform?.['pt-kit']).toBeUndefined();
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','pt-kit').description).toBe('');
    expect(assets.readVnSpriteOutfit(source,'Alice','uniform','formal').expressions.normal).toBe('@asset:formal');
    expect(assets.readVnAssetMap(source,'sprites')).toEqual(assets.readVnAssetMap(original,'sprites'));
  });

  it('keeps a literal variant named normal distinct from the base outfit', () => {
    let source = assets.addVnSpriteVariant(original,'normal','Normal');
    source = assets.assignVnSprite(source,'Alice','normal','normal','@asset:variation','normal');
    expect(assets.readVnSpriteOutfit(source,'Alice').expressions.normal).toBe('@asset:base');
    expect(assets.readVnSpriteOutfit(source,'Alice','normal','normal').expressions.normal).toBe('@asset:variation');
  });

  it('infers variant-only characters, types and expression IDs without evaluating code', () => {
    const source = original+'\nexport const spriteVariantSprites = {festival:{rain:{Cara:{weary:"@asset:rain"}}}};\nexport const spriteVariantWardrobeDescriptions = {Dora:{festival:{rain:"A raincoat."}}};';
    const inventory = assets.readVnSpriteInventory(source);
    expect(inventory.characters).toEqual(['Alice','Cara','Dora']);
    expect(inventory.config.types.festival).toBe('Festival');
    expect(inventory.config.emotions.weary).toBe('Weary');
    expect(inventory.variants.festival?.rain).toBe('Rain');
    expect(()=>assets.readVnSpriteVariantSets(original+'\nexport const spriteVariantSprites = executeCode();')).toThrow();
  });

  it('preserves every variant binding and chapter default through helper refreshes', () => {
    let source = assets.assignVnSprite(outfit(),'Alice','uniform','normal','@asset:pt','pt-kit');
    source = assets.writeVnSpriteWardrobeDescription(source,'Alice','uniform','PT kit.','pt-kit');
    source = assets.writeVnSpriteChapterDefault(source,['opening-a','opening-b'],'Alice',{type:'uniform',variant:'pt-kit'});
    const refreshed = assets.preserveVnAssetConfiguration(source,'export const sprites = {};\n// refreshed helper\n','sprites');
    expect(assets.readVnSpriteInventory(refreshed)).toEqual(assets.readVnSpriteInventory(source));
    expect(assets.readVnSpriteChapterDefaults(refreshed)['opening-b']?.Alice).toEqual({type:'uniform',variant:'pt-kit'});
  });

  it('removes only a deleted variant from chapter presets', () => {
    let source = assets.writeVnSpriteChapterDefault(outfit(),['opening-a'],'Alice',{type:'uniform',variant:'pt-kit'});
    source = assets.writeVnSpriteChapterDefault(source,['opening-a'],'Bob',{type:'normal'});
    source = assets.removeVnSpriteVariant(source,'uniform','pt-kit');
    expect(assets.readVnSpriteChapterDefaults(source)).toEqual({'opening-a':{Bob:{type:'normal'}}});
  });

  it('rejects unknown or unsafe variant targets without changing existing source', () => {
    expect(()=>assets.assignVnSprite(outfit(),'Alice','uniform','normal','@asset:x','missing')).toThrow(/variant/i);
    expect(()=>assets.addVnSpriteVariant(original,'missing','PT')).toThrow();
    expect(()=>assets.addVnSpriteVariant(original,'normal','constructor')).toThrow();
    expect(()=>assets.assertVnSpriteCatalogUpdate(original,original+'\nexport const spriteVariants = {normal:{"__proto__":"Bad"}};')).toThrow();
    expect(()=>assets.writeVnSpriteChapterDefault(outfit(),['opening'],'Alice',{type:'uniform',variant:'missing'})).toThrow();
    expect(()=>assets.writeVnSpriteWardrobeDescription(outfit(),'__proto__','uniform','Gold sash.','pt-kit')).toThrow();
    expect(()=>assets.assignVnSprite(outfit(),'__proto__','uniform','normal','@asset:bad','pt-kit')).toThrow();
  });
});
