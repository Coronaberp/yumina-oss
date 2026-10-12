import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../prompts/prompt-builder.js';
import { createMockWorld, createMockGameState } from './test-utils.js';

describe('session persona control in VN prompts', () => {
  const world = createMockWorld({ rootComponent: { interfaceId: 'vn', name: 'VN', entryFile: 'index.tsx', files: {} } });
  const builder = new PromptBuilder();
  it('permits repeated persona participation only when AI control is explicitly selected', () => {
    const prefix = builder.buildStaticFormatBlock(world, 'ai');
    const tail = builder.buildPostHistoryEntries(world, createMockGameState(), undefined, undefined, undefined, 'ai').at(-1)?.content;
    for (const prompt of [prefix, tail]) {
      expect(prompt).toContain('AI controlled');
      expect(prompt).toContain('[SPEAKER:{{user}}:emotion]');
      expect(prompt).toMatch(/multiple times/);
      expect(prompt).toMatch(/explicit.*(?:input|direction).*priority/i);
      expect(prompt).not.toContain('Player control is absolute');
    }
  });
  it('default and assisted story generation remain player controlled', () => {
    for (const mode of [undefined, 'player', 'assisted'] as const) {
      expect(builder.buildStaticFormatBlock(world, mode)).toContain('NEVER write speech');
      expect(builder.buildPostHistoryEntries(world, createMockGameState(), undefined, undefined, undefined, mode).at(-1)?.content).toContain('Never emit a player speaker tag');
    }
  });
});
