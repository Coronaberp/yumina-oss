import { describe, expect, it } from 'vitest';
import { normalizeSpriteExpression } from '../parser/sprite-expressions.js';
import { standardizeSpeakerMarkup } from '../parser/presentation-markup.js';

describe('sprite type markup', () => {
  it('keeps exact configured emotions ahead of aliases', () => {
    expect(normalizeSpriteExpression('Embarrassed', { embarrassed: 'Embarrassed' })).toBe('embarrassed');
    expect(normalizeSpriteExpression('Curious', { curious: 'Curious' })).toBe('curious');
    expect(normalizeSpriteExpression('blushing', { embarrassed: 'Embarrassed' })).toBe('shy');
    expect(normalizeSpriteExpression('Custom Emotion', { 'Custom Emotion': 'Custom Emotion' })).toBe('Custom Emotion');
  });
  it('preserves normalized raw emotions and optional type until card-aware selection', () => {
    expect(standardizeSpeakerMarkup('[Name:Maeve:Embarrassed:Battle Wear]')).toBe('[SPEAKER:Maeve:embarrassed:battle-wear]');
    expect(standardizeSpeakerMarkup('<dialogue name="Maeve" emotion="Curious" spriteType="Battle Wear">Why?</dialogue>')).toBe('[SPEAKER:Maeve:curious:battle-wear]\n“Why?”');
    expect(standardizeSpeakerMarkup('[SPEAKER:Maeve:embarrassed]')).toBe('[SPEAKER:Maeve:embarrassed]');
  });
  it('preserves NPC gender and stable identity and ignores wardrobe metadata for narrator', () => {
    expect(standardizeSpeakerMarkup('[SPEAKER:NPC:happy:Female:merchant:2]')).toBe('[SPEAKER:NPC:happy:female:merchant:2]');
    expect(standardizeSpeakerMarkup('[SPEAKER:Narrator:curious:battle]')).toBe('[SPEAKER:Narrator:normal]');
  });
});

import { buildSpeakerFormatBlock, buildVnTurnReminder } from '../prompts/speaker-tag.js';

it('advertises card-specific emotion and wardrobe IDs compactly in both prompt blocks', () => {
  const world = { entries: [{id:'maeve', name:'Maeve', role:'character' as const, content:'', enabled:true}], variables: [], rootComponent: {interfaceId:'vn', entryFile:'index.tsx', files:{'index.tsx':'', 'sprites.ts':'export const sprites = {};\nexport const spriteConfig = {types:{normal:"Normal",battle:"Battle Wear"},emotions:{normal:"Normal",embarrassed:"Embarrassed",curious:"Curious"}};'}} };
  for (const prompt of [buildSpeakerFormatBlock(world), buildVnTurnReminder(world)]) {
    expect(prompt).toContain('Sprite types: normal, battle.');
    expect(prompt).toContain('embarrassed');
    expect(prompt).toContain('curious');
    expect(prompt).toContain('[SPEAKER:Name:emotion:type]');
    expect(prompt).toContain('Omitting type keeps the current outfit');
    expect(prompt).not.toContain('ONLY one of these six');
    expect(prompt).toContain('[SPEAKER:NPC:emotion:male:stable-id]');
  }
});

it('preserves nested variants and omission without changing NPC identity fields', () => {
  expect(standardizeSpeakerMarkup('[SPEAKER:Maeve:curious:casual:Evening Dress]')).toBe('[SPEAKER:Maeve:curious:casual:evening-dress]');
  expect(standardizeSpeakerMarkup('<dialogue name="Maeve" emotion="curious" spriteType="casual" spriteVariant="Evening Dress">Why?</dialogue>')).toBe('[SPEAKER:Maeve:curious:casual:evening-dress]\n“Why?”');
  expect(standardizeSpeakerMarkup('[SPEAKER:Maeve:curious]')).toBe('[SPEAKER:Maeve:curious]');
  expect(standardizeSpeakerMarkup('[SPEAKER:Maeve:curious:???]')).toBe('[SPEAKER:Maeve:curious]');
  expect(standardizeSpeakerMarkup('[SPEAKER:Maeve:curious:casual:???]')).toBe('[SPEAKER:Maeve:curious]');
  expect(standardizeSpeakerMarkup('[SPEAKER:NPC:normal:female:merchant:2]')).toBe('[SPEAKER:NPC:normal:female:merchant:2]');
});

import { readFileSync } from 'node:fs';
import { normalizeSpriteId, normalizeSpriteSelectionId } from '../parser/sprite-expressions.js';
function spriteRuntime(extra = '') {
  const source = readFileSync(new URL('../../../../interfaces/vn/sprites.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  return new Function('normalizeSpriteExpression', 'normalizeSpriteId', 'normalizeSpriteSelectionId', 'messagePassages', source + '\n' + extra + '\nreturn { spriteFor, sceneSprites, spriteWardrobesFor, spriteOutfitFor };')(
    normalizeSpriteExpression, normalizeSpriteId, normalizeSpriteSelectionId, (_api: unknown, message: any) => message.lines || [],
  );
}
it('keeps fallback inside the selected outfit and never substitutes another outfit or NPC', () => {
  const runtime = spriteRuntime();
  const api = { variables: { 'vn-sprites': { Maeve: { normal: 'uniform' } }, 'vn-sprite-config': { types: { normal: 'Normal', casual: 'Casual', work: 'Work' } }, 'vn-sprite-variants': { casual: { evening: 'Evening', missing: 'Missing art' } }, 'vn-sprite-types': { casual: { Maeve: { curious: 'casual-curious', sad: 'casual-sad' } } }, 'vn-sprite-variant-sprites': { casual: { evening: { Maeve: { happy: 'evening-happy' } } } } }, resolveAssetUrl: (value: string) => value };
  expect(runtime.spriteFor(api, { name: 'Maeve', spriteType: 'casual', emotion: 'unavailable' })).toBe('casual-curious');
  expect(runtime.spriteFor(api, { name: 'Maeve', spriteType: 'casual', spriteVariant: 'evening', emotion: 'sad' })).toBe('evening-happy');
  expect(runtime.spriteFor(api, { name: 'Maeve', spriteType: 'casual', spriteVariant: 'missing' })).toBeNull();
  expect(runtime.spriteFor(api, { name: 'Maeve', spriteType: 'work' })).toBeNull();
});
it('retains type and variant through omitted tags, resets an explicit type to base, and respects the reading cursor', () => {
  const runtime = spriteRuntime();
  const first = { id: 'old', role: 'assistant', lines: [{ name: 'Maeve', spriteType: 'casual', spriteVariant: 'evening' }] };
  const current = { id: 'now', role: 'assistant', lines: [{ name: 'Maeve', emotion: 'happy' }, { name: 'Maeve', spriteType: 'work' }] };
  const future = { id: 'future', role: 'assistant', lines: [{ name: 'Maeve', spriteType: 'battle' }] };
  const api = { entries: [], messages: [first, current, future], variables: { 'vn-sprite-config': { types: {normal:'Normal', casual:'Casual',work:'Work',battle:'Battle'} }, 'vn-sprite-variants': { casual: { evening:'Evening' } } } };
  expect(runtime.spriteWardrobesFor(api, current, [current.lines[0]]).maeve).toEqual({ type: 'casual', variant: 'evening' });
  expect(runtime.spriteWardrobesFor(api, current, current.lines).maeve).toEqual({ type: 'work', variant: '' });
  expect(runtime.spriteWardrobesFor(api, current, [{name:'Maeve',spriteType:'casual',spriteVariant:'unknown'}]).maeve).toEqual({ type: 'casual', variant: 'evening' });
  expect(runtime.spriteWardrobesFor(api, current, [{name:'Maeve',spriteType:'unknown'}]).maeve).toEqual({ type: 'casual', variant: 'evening' });
});
it('applies the selected opening default and excludes wardrobes from another opening', () => {
  const runtime = spriteRuntime('spriteChapterDefaults.openingB = { Maeve: { type: "casual", variant: "evening" } }; spriteVariants.casual = {evening:"Evening"};');
  const old = { id: 'old', role: 'assistant', stateSnapshot: { activeGreetingId: 'openingA' }, lines: [{ name: 'Maeve', spriteType: 'battle' }] };
  const current = { id: 'now', role: 'assistant', stateSnapshot: { activeGreetingId: 'openingB' }, lines: [{ name: 'Maeve', emotion: 'happy' }] };
  expect(runtime.spriteWardrobesFor({ entries: [], messages: [old, current], hasEarlierMessages: true }, current, current.lines).maeve).toEqual({ type: 'casual', variant: 'evening' });
});

it('keeps the VN prompt usable when an older custom card has no literal sprite map', () => {
  for (const source of ['', 'export const sprites = loadCustomSprites();']) {
    const world = { entries: [], variables: [], rootComponent: {interfaceId:'vn', entryFile:'index.tsx', files:{'index.tsx':'', 'sprites.ts':source}} };
    expect(buildSpeakerFormatBlock(world)).toContain('Sprite types: normal.');
  }
});

it('uses the selected snapshot before map when older markers are not loaded, without leaking later passages', () => {
 const runtime=spriteRuntime();
 const before={Maeve:{type:'casual',variant:'evening'}}, after={Maeve:{type:'work',variant:''}};
 const current={id:'now',role:'assistant',stateSnapshot:{activeGreetingId:'opening',metadata:{vnSpriteWardrobes:{version:1,openingId:'opening',before,after}}},lines:[{name:'Maeve'}, {name:'Maeve',spriteType:'work'}]};
 const api={messages:[current],hasEarlierMessages:true,variables:{'vn-sprite-config':{types:{normal:'Normal',casual:'Casual',work:'Work'}},'vn-sprite-variants':{casual:{evening:'Evening'}}}};
 expect(runtime.spriteWardrobesFor(api,current,[current.lines[0]]).maeve).toEqual(before.Maeve);
 expect(runtime.spriteWardrobesFor(api,current,current.lines).maeve).toEqual(after.Maeve);
 const alternate={...current,stateSnapshot:{...current.stateSnapshot,metadata:{vnSpriteWardrobes:{version:1,openingId:'opening',before:{Maeve:{type:'normal',variant:''}},after}}}};
 expect(runtime.spriteWardrobesFor({...api,messages:[alternate]},alternate,[alternate.lines[0]]).maeve.type).toBe('normal');
 const mismatched={...current,stateSnapshot:{...current.stateSnapshot,activeGreetingId:'other'}};
 expect(runtime.spriteWardrobesFor({...api,messages:[mismatched]},mismatched,[mismatched.lines[0]]).maeve).toBeUndefined();
});

it('reads a pruned reply from response-only hydration and replays alternate swipes from the same before map', () => {
 const runtime=spriteRuntime();
 const saved={version:1,openingId:'opening',activeSwipeIndex:0,before:{Maeve:{type:'casual',variant:'evening'}},after:{Maeve:{type:'work',variant:''}}};
 const current={id:'old',role:'assistant',stateSnapshot:null,spriteWardrobeSnapshot:saved,activeSwipeIndex:1,lines:[{name:'Maeve'}]};
 const next={id:'next',role:'assistant',lines:[{name:'Maeve'}]};
 const api={messages:[current,next],hasEarlierMessages:true,variables:{'vn-sprite-config':{types:{normal:'Normal',casual:'Casual',work:'Work'}},'vn-sprite-variants':{casual:{evening:'Evening'}}}};
 expect(runtime.spriteWardrobesFor(api,current,current.lines).maeve).toEqual(saved.before.Maeve);
});

it('uses a restored opening snapshot ahead of stale response hydration after a greeting switch', () => {
 const runtime=spriteRuntime('spriteChapterDefaults.openingB = { Maeve: { type: "work" } };');
 const current={id:'greeting',role:'assistant',activeSwipeIndex:1,
  stateSnapshot:{activeGreetingId:'openingB'},
  spriteWardrobeSnapshot:{version:1,openingId:'openingA',activeSwipeIndex:0,before:{Maeve:{type:'casual',variant:'evening'}},after:{Maeve:{type:'casual',variant:'evening'}}},
  lines:[{name:'Maeve'}]};
 const api={messages:[current],hasEarlierMessages:false,variables:{'vn-sprite-config':{types:{normal:'Normal',casual:'Casual',work:'Work'}},'vn-sprite-variants':{casual:{evening:'Evening'}}}};
 expect(runtime.spriteWardrobesFor(api,current,current.lines).maeve).toEqual({type:'work',variant:''});
});

it('replays earlier active swipes through later omitted tags instead of reseeding stale saved outcomes', () => {
 const runtime=spriteRuntime();
 const old={version:1,openingId:'opening',before:{Maeve:{type:'normal',variant:''}},after:{Maeve:{type:'work',variant:''}}};
 const first={id:'first',role:'assistant',activeSwipeIndex:1,stateSnapshot:{activeGreetingId:'opening',metadata:{vnSpriteWardrobes:old}},
  spriteWardrobeSnapshot:{...old,before:{Maeve:{type:'casual',variant:'evening'}},activeSwipeIndex:0},lines:[{name:'Maeve',spriteType:'battle'}]};
 const middle={id:'middle',role:'assistant',stateSnapshot:{activeGreetingId:'opening',metadata:{vnSpriteWardrobes:{...old,before:old.after}}},lines:[{name:'Maeve'}]};
 const current={id:'current',role:'assistant',stateSnapshot:{activeGreetingId:'opening',metadata:{vnSpriteWardrobes:{...old,before:old.after}}},lines:[{name:'Maeve'}]};
 const api={messages:[first,middle,current],hasEarlierMessages:true,variables:{'vn-sprite-config':{types:{normal:'Normal',casual:'Casual',work:'Work',battle:'Battle'}},'vn-sprite-variants':{casual:{evening:'Evening'}}}};
 expect(runtime.spriteWardrobesFor(api,current,current.lines).maeve).toEqual({type:'battle',variant:''});
 // Hydrated earliest-before takes precedence over a stale stored baseline.
 const omitted={...first,lines:[{name:'Maeve'}]};
 expect(runtime.spriteWardrobesFor({...api,messages:[omitted,middle,current]},current,current.lines).maeve).toEqual({type:'casual',variant:'evening'});
});
