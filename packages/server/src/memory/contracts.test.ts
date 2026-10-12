import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FACT_TYPES, SOURCE_PARITY_VERSION } from './types.js';

test('memory contracts preserve all twelve StoryHaven fact types', () => {
  assert.deepEqual(FACT_TYPES, ['event', 'state', 'relationship', 'world', 'profile', 'promise', 'conflict', 'injury', 'illness', 'inventory', 'equipment', 'mood']);
  assert.equal(SOURCE_PARITY_VERSION, 'd2e2f96236bbc95512719204126395bd87561302');
});

test('parity manifest pins every source algorithm and repository', async () => {
  const manifest = JSON.parse(await readFile(new URL('./source-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.commit, SOURCE_PARITY_VERSION);
  for (const path of ['backend/memory/config.py', 'backend/memory/extraction.py', 'backend/memory/ranking.py', 'backend/memory/block.py', 'backend/memory/lore.py', 'backend/memory/clusters.py', 'backend/memory/service.py', 'backend/retrieval.py', 'backend/vectors.py', 'backend/inference/embeddings.py', 'backend/repositories/memory_facts.py']) {
    assert.match(manifest.files[path], /^[a-f0-9]{64}$/, path);
  }
});
