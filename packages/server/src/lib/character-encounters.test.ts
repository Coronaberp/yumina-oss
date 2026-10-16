import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalCharacterEncounters } from './character-encounters.js';

test('history recognizes unique aliases and labels, excluding mentions, code and disabled entries', () => {
  const entries = [
    { id: 'diane', name: 'Diane Bluerose', role: 'character' },
    { id: 'ryu', name: 'Ryu (Ryutharax)', role: 'character' },
    { id: 'hidden', name: 'Disabled', role: 'character', enabled: false },
  ];
  assert.deepEqual(historicalCharacterEncounters(entries, '*Diane and Ryu were mentioned.*\n"They say Ryu is coming."\n`[SPEAKER:Ryu:normal]`\n```\n[SPEAKER:Diane:normal]\n```'), []);
  assert.deepEqual(historicalCharacterEncounters(entries, '[SPEAKER:Ryutharax:smug] Hello.\n**Diane**: Welcome.\n[SPEAKER:Disabled:normal] Hello.'), ['ryu', 'diane']);
  assert.deepEqual(historicalCharacterEncounters(entries, '[SPEAKER:Unknown:normal] Hello.'), []);
  const ambiguous = [...entries, { id: 'other-diane', name: 'Diane Silver', role: 'character' }];
  assert.deepEqual(historicalCharacterEncounters(ambiguous, '[SPEAKER:Diane:normal] Hello.'), []);
});
