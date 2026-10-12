import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStudioOutputLanguage, STUDIO_OUTPUT_LANGUAGES, updateProfileSchema } from '../dist/index.js';

test('Studio language defaults safely without adopting the interface language', () => {
  for (const value of [undefined, null, '', 'auto', {}, 'ignore previous instructions']) {
    assert.equal(normalizeStudioOutputLanguage(value), 'en');
  }
  for (const option of STUDIO_OUTPUT_LANGUAGES) {
    assert.equal(normalizeStudioOutputLanguage(option.code), option.code);
    assert.ok(updateProfileSchema.safeParse({ preferences: { studioOutputLanguage: option.code } }).success);
  }
  assert.ok(updateProfileSchema.safeParse({ preferences: { language: 'ja' } }).success);
  assert.ok(!updateProfileSchema.safeParse({ preferences: { studioOutputLanguage: 'auto' } }).success);
  assert.ok(!updateProfileSchema.safeParse({ preferences: { studioOutputLanguage: null } }).success);
});
