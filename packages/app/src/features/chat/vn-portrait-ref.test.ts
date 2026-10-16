import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { portraitRef } from '../../../../../interfaces/vn/portrait-ref';
import { upgradeVnPortraitFiles } from './vn-portrait-upgrade';
const id = '11111111-2222-4333-8444-555555555555';
test('small VN portraits request the cached portrait variant on installation CDN paths', () => {
  assert.equal(portraitRef(`@asset:${id}`), `/cdn/${id}?variant=portrait`);
  assert.equal(portraitRef(`/cdn/${id}`), `/cdn/${id}?variant=portrait`);
  assert.equal(portraitRef('https://vn.storyhaven.dev/cdn/key/YmFzZTY0'), 'https://vn.storyhaven.dev/cdn/key/YmFzZTY0?variant=portrait');
  for (const ref of ['blob:test', 'data:image/png;base64,test', 'https://example.com/image.png', '/vn-assets/portrait.png']) assert.equal(portraitRef(ref), ref);
});
test('saved shipped portrait renderers upgrade surgically and idempotently, including nested roots', () => {
  const source = readFileSync(new URL('../../../../../interfaces/vn/index.tsx', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../../../../../interfaces/vn/portrait-ref.ts', import.meta.url), 'utf8');
  const old = source.replace('import { portraitRef } from "./portrait-ref";\n', '').replace('api.resolveAssetUrl(portraitRef(portrait))', 'api.resolveAssetUrl(portrait)');
  const files = { 'ui/root.tsx': old, 'sprites.ts': 'authored art', 'index.tsx': 'composed root' };
  const upgraded = upgradeVnPortraitFiles(files, helper);
  assert.match(upgraded['ui/root.tsx'], /resolveAssetUrl\(portraitRef\(portrait\)\)/);
  assert.equal(upgraded['ui/portrait-ref.ts'], helper);
  assert.equal(upgraded['sprites.ts'], 'authored art'); assert.equal(upgraded['index.tsx'], 'composed root');
  assert.equal(upgradeVnPortraitFiles(upgraded, helper), upgraded);
  const custom = { 'index.tsx': 'export default function World(){return <Chat />;}' };
  assert.equal(upgradeVnPortraitFiles(custom, helper), custom);
  const oldMemo = { ...upgraded, 'ui/root.tsx': upgraded['ui/root.tsx'].replace('[api, visible, characters', '[visible, characters') };
  assert.match(upgradeVnPortraitFiles(oldMemo, helper)['ui/root.tsx'], /\[api, visible, characters/);
});
