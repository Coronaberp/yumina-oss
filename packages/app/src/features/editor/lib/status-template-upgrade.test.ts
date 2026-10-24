import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusTemplates } from '../../../../../engine/src/world/status-templates.generated';
import { statusTabsV1Templates } from '../../../../../engine/src/world/status-tabs-v1-templates';
import { currentStatusFiles } from './status-template-upgrade';

describe('Status runtime compatibility scope', () => {
  it('keeps explicit classic files unchanged even after a VN upgrade is cached', () => {
    const files = { ...statusTemplates, ...statusTabsV1Templates };
    const upgraded = currentStatusFiles(files, 'vn');
    assert.equal(upgraded['status-sheet.tsx'], statusTemplates['status-sheet.tsx']);
    assert.notEqual(upgraded, files);
    assert.equal(currentStatusFiles(files, 'classic'), files);
    assert.equal(currentStatusFiles(files), upgraded);
    assert.equal(files['status-sheet.tsx'], statusTabsV1Templates['status-sheet.tsx']);
  });
  it('does not let classic scope poison the legacy VN upgrade cache', () => {
    const files = { ...statusTemplates, ...statusTabsV1Templates };
    assert.equal(currentStatusFiles(files, 'classic'), files);
    assert.equal(currentStatusFiles(files)['status-sheet.tsx'], statusTemplates['status-sheet.tsx']);
  });
});
