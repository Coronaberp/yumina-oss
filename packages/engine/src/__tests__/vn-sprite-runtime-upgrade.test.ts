import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spriteRuntimeBases } from '../world/sprite-runtime-upgrade-bases.generated.js';
import { upgradeVnSpriteFiles } from '../world/vn-sprite-runtime-upgrade.js';
import { spriteRuntimeVariantsBase } from '../world/sprite-runtime-variants-base.generated.js';

it('upgrades exact sprite fragments while retaining custom paging, rendering, NPC logic and asset literals', () => {
  const files = {...spriteRuntimeBases, 'index.tsx':'// Custom card root', 'custom.ts':'export const kept = 42;'};
  files['sprites.ts'] = files['sprites.ts']!.replace('export const sprites = {};','export const sprites = {Maeve:{normal:"@asset:mine"}};').replace('function playerNpcSpriteSelection(api, line) {', 'function playerNpcSpriteSelection(api, line) {\n  // Authored persona fallback custom code');
  files['passages.ts'] = files['passages.ts']!.replace('while (text.length > 280)', 'while (text.length > 420)') + '\nexport function customAlias(value) { return normalizeSpriteExpression(value); }\n';
  files['character-viewer.tsx'] += '\n// Authored viewer styling\n';
  const result=upgradeVnSpriteFiles(files);
  expect(result['sprites.ts']).toContain('spriteTypes');
  expect(result['sprites.ts']).toContain('export const sprites = {Maeve:{normal:"@asset:mine"}};');
  expect(result['sprites.ts']).toContain('// Authored persona fallback custom code');
  expect(result['passages.ts']).toContain('while (text.length > 420)');
  expect(result['passages.ts']).toContain('spriteType: chunk.spriteType');
  expect(result['passages.ts']).toContain('export function customAlias(value) { return normalizeSpriteExpression(value); }');
  expect(result['character-viewer.tsx']).toContain('// Authored viewer styling');
  expect(result['custom.ts']).toBe(files['custom.ts']);
  expect(result['index.tsx']).toBe(files['index.tsx']);
  expect(upgradeVnSpriteFiles(result)).toEqual(result);
  expect(files['sprites.ts']).not.toContain('spriteTypes');
});

it('refuses unknown resolver edits atomically instead of replacing custom code',()=>{
  const files={...spriteRuntimeBases};
  files['sprites.ts']=files['sprites.ts']!.replace('return typeof ref === "string" && ref ? { src: api.resolveAssetUrl(ref) } : npcSpriteSelection(api, line);','return myCustomResolver(ref);');
  expect(()=>upgradeVnSpriteFiles(files)).toThrow(/sprites\.ts.*custom/);
  expect(files['sprites.ts']).toContain('return myCustomResolver(ref);');
  expect(files['sprites.ts']).not.toContain('spriteTypes');
});

it('current source is an idempotent upgrade target',()=>{
  const files=Object.fromEntries(Object.keys(spriteRuntimeBases).map(file=>[file,readFileSync(new URL('../../../../interfaces/vn/'+file,import.meta.url),'utf8')]));
  expect(upgradeVnSpriteFiles(files)).toEqual(files);
});

it('upgrades the deployed wardrobe runtime while keeping custom artwork and unrelated UI bytes', () => {
  const files = { ...spriteRuntimeVariantsBase, 'custom-content.ts': 'export const custom = "kept";' };
  files['sprites.ts'] = files['sprites.ts']!.replace('export const sprites = {};', 'export const sprites = {Alice:{normal:"@asset:mine"}};') + '\nexport function authoredAssetLogic() { return "untouched"; }\n';
  files['passages.ts'] = files['passages.ts']!.replace('while (text.length > 280)', 'while (text.length > 420)');
  files['index.tsx'] += '\n// Custom root decoration\n';
  const upgraded = upgradeVnSpriteFiles(files);
  expect(upgraded['sprites.ts']).toContain('export const spriteVariants');
  expect(upgraded['sprites.ts']).toContain('export const sprites = {Alice:{normal:"@asset:mine"}};');
  expect(upgraded['sprites.ts']).toContain('export function authoredAssetLogic() { return "untouched"; }');
  expect(upgraded['passages.ts']).toContain('while (text.length > 420)');
  expect(upgraded['passages.ts']).toContain('spriteVariant');
  expect(upgraded['index.tsx']).toContain('sceneSprites(sceneApi, spriteLines, spriteLimit, currentMessage)');
  expect(upgraded['index.tsx']).toContain('// Custom root decoration');
  expect(upgraded['custom-content.ts']).toBe(files['custom-content.ts']);
  expect(upgradeVnSpriteFiles(upgraded)).toEqual(upgraded);
});

import { upgradePersonaRoot } from '../world/persona-runtime-upgrade.js';
it('updates recognizable legacy sprites for restored custom roots without changing their custom entry',()=>{
 const root:any={id:'custom-root',entryFile:'index.tsx',files:{...spriteRuntimeBases,'index.tsx':'export default function MyCustomUI(){return null;}'},compiled:{code:'old'}};
 const updated=upgradePersonaRoot(root);
 expect(updated.files['sprites.ts']).toContain('export const spriteTypes');
 expect(updated.files['index.tsx']).toBe(root.files['index.tsx']);
 expect(updated.compiled).toBeUndefined();
 expect(upgradePersonaRoot(updated)).toEqual(updated);
});

it('preserves existing optional variant literals and chapter presets without reseeding them', () => {
  const extras = '\nexport const spriteVariants = {normal:{rain:"Rain"}};\nexport const spriteVariantSprites = {normal:{rain:{Alice:{sad:"@asset:rain"}}}};\nexport const spriteVariantWardrobeDescriptions = {Alice:{normal:{rain:"Blue coat"}}};\nexport const spriteChapterDefaults = {opening:{Alice:{type:"normal",variant:"rain"}}};\n';
  const files = {...spriteRuntimeVariantsBase};
  files['sprites.ts'] += extras;
  const upgraded = upgradeVnSpriteFiles(files);
  expect(upgraded['sprites.ts']).toContain(extras);
  expect(upgradeVnSpriteFiles(upgraded)).toEqual(upgraded);
});

it('rejects unknown custom new helper declarations atomically', () => {
  const files = {...spriteRuntimeVariantsBase};
  files['sprites.ts'] += '\nexport function spriteOutfitFor() { return customResolver(); }\n';
  const before = {...files};
  expect(() => upgradeVnSpriteFiles(files)).toThrow(/custom sprite declaration spriteOutfitFor/);
  expect(files).toEqual(before);
});

it('preserves custom index neighbors and rejects an unknown sceneSprites call shape', () => {
  const files = {...spriteRuntimeVariantsBase};
  files['index.tsx'] = files['index.tsx']!.replace('draftContext.current =', '// Custom neighboring decoration\n  draftContext.current =');
  const upgraded = upgradeVnSpriteFiles(files);
  expect(upgraded['index.tsx']).toContain('// Custom neighboring decoration');
  expect(upgraded['index.tsx']).toContain('sceneSprites(sceneApi, spriteLines, spriteLimit, currentMessage)');
  const unknown = {...files, 'index.tsx':files['index.tsx']!.replace('sceneSprites(sceneApi, spriteLines, spriteLimit)', 'sceneSprites(customApi, customLines, 1)')};
  expect(() => upgradeVnSpriteFiles(unknown)).toThrow(/index.tsx.*custom/);
});

const savedDialects: {dialect: string; files: Record<string, string>}[] = JSON.parse(readFileSync(new URL('./fixtures/vn-saved-sprite-dialects.json', import.meta.url), 'utf8'));
for (const fixture of savedDialects) {
  it(`preserves authored helper dialect ${fixture.dialect} and upgrades it idempotently`, () => {
    const files = {...spriteRuntimeVariantsBase, ...fixture.files};
    const upgraded = upgradeVnSpriteFiles(files);
    expect(upgraded['passages.ts']).toContain('spriteVariant: chunk.spriteVariant');
    expect(upgraded['sprites.ts']).toContain('export function spriteWardrobesFor');
    expect(upgradeVnSpriteFiles(upgraded)).toEqual(upgraded);
    // Reverse the narrowly added parser fields; all rendering, paging, NPC,
    // literal protection and attribution code must remain byte-for-byte.
    const original = files['passages.ts']!;
    const restored = upgraded['passages.ts']!
      .replace(', normalizeSpriteSelectionId } from "./expressions";', ' } from "./expressions";')
      .replace('  let spriteType, spriteVariant;', '  let spriteType = "normal";')
      .replace(' && initialFields[1] ? normalizeSpriteId(initialFields[1]) : undefined;\n  let spriteVariant = spriteType && initialFields[2] ? normalizeSpriteId(initialFields[2]) : undefined;', ' ? normalizeSpriteId(initialFields[1]) : "normal";')
      .replaceAll('spriteType, spriteVariant, scene', 'spriteType, scene')
      .replace(' && fields[1] ? normalizeSpriteId(fields[1]) : undefined;\n      spriteVariant = spriteType && fields[2] ? normalizeSpriteId(fields[2]) : undefined;', ' ? normalizeSpriteId(fields[1]) : "normal";')
      .replace('spriteType: chunk.spriteType, spriteVariant: chunk.spriteVariant,', 'spriteType: chunk.spriteType,')
      .replace('      const typeId = normalizeSpriteSelectionId(segment.spriteType);\n      const variantId = segment.spriteVariant == null || segment.spriteVariant === "" ? "" : normalizeSpriteSelectionId(segment.spriteVariant);\n      const spriteType = name !== "NPC" && name !== "Narrator" && typeId && variantId !== undefined\n        ? `:${typeId}${variantId ? `:${variantId}` : ""}` : "";', '      const spriteType = name !== "NPC" && name !== "Narrator" ? `:${normalizeSpriteId(segment.spriteType)}` : "";');
    expect(restored).toBe(original);
    if (files['sprites.ts']!.includes('const pinned = resolved.find')) {
      expect(upgraded['sprites.ts']).toContain('const pinned = resolved.find');
      expect(upgraded['sprites.ts']).toContain('const kept = pinned');
    }
  });
}
