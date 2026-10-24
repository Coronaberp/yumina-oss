import assert from 'node:assert/strict';
import test from 'node:test';
import { GameStateManager, parseGuardedResponse, ResponseParser, type WorldDefinition } from '@yumina/engine';
import type { TurnOutputContext } from './extension-hooks.js';
import { guardTurnOutput } from '../extensions/state-update-guard/validate.js';
import { purgePlayerAgency } from './player-agency.js';

const world: WorldDefinition = {
  id: 'player-receipt-fixture', name: 'Receipt fixture', version: '1.0.0', author: 'test', description: '',
  variables: [{ id: 'energy', name: 'Energy', type: 'number', defaultValue: 100, min: 0, max: 100 }],
  entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
};
const state = () => new GameStateManager(world).getSnapshot();
const updated = '<yumina-state version="1" status="updated" count="1" />';
const none = '<yumina-state version="1" status="none" />';
const clean = (raw: string) => purgePlayerAgency(new ResponseParser().parse(raw), raw);
const rawUpdated = `[SPEAKER:You:normal]\nYou nod.\n[energy: subtract 5]\n${updated}`;
const rawNone = `[SPEAKER:Mara:normal]\n"The gate is closed."\n[SPEAKER:You:normal]\nYou nod.\n${none}`;

test('player dialogue cleanup preserves an updated receipt and its state command', () => {
  assert.equal(parseGuardedResponse(rawUpdated, world, state()).outcome, 'valid-updates');
  const result = clean(rawUpdated);
  assert.equal(result.removed, true);
  assert.doesNotMatch(result.raw, /You nod/);
  assert.ok(result.raw.includes(updated), 'retain hidden protocol metadata when removing player prose');
  const parsed = parseGuardedResponse(result.raw, world, state());
  assert.equal(parsed.outcome, 'valid-updates');
  assert.deepEqual(parsed.effects, [{ variableId: 'energy', operation: 'subtract', value: 5 }]);
});

test('player dialogue cleanup preserves explicit-none receipt and other NPC dialogue', () => {
  assert.equal(parseGuardedResponse(rawNone, world, state()).outcome, 'explicit-none');
  const result = clean(rawNone);
  assert.doesNotMatch(result.raw, /You nod/);
  assert.match(result.raw, /The gate is closed/);
  assert.ok(result.raw.includes(none));
  assert.equal(parseGuardedResponse(result.raw, world, state()).outcome, 'explicit-none');
});

for (const [label, raw, outcome] of [
  ['updated', rawUpdated, 'valid-updates'], ['none', rawNone, 'explicit-none'],
] as const) {
  test(`${label} receipt survives the real State Guard without a correction request`, async () => {
    const cleaned = clean(raw);
    const initial = state();
    const before = structuredClone(initial);
    let calls = 0;
    const ctx: TurnOutputContext = {
      world, state: initial, raw: cleaned.raw, parsed: cleaned.parsed,
      model: 'fixture/model', maxContext: 32_000, signal: new AbortController().signal,
      provider: { async *generateStream() { calls++; throw new Error('Unexpected correction request'); }, async listModels() { return []; } },
      audit: { version: 1, attemptId: 'receipt-test', path: 'send', outcome: 'validating', diagnostics: [], parsedCount: 0, repaired: false,
        correctionCount: 0, model: 'fixture/model', apiKeyTier: 'byok', startedAt: new Date().toISOString(), baselineFingerprint: 'fixture', usageLogIds: [] },
      history: [], mayCorrect: async () => true,
      progress: async () => { throw new Error('Unexpected correction progress'); },
      recordUsage: async () => { throw new Error('Unexpected correction usage'); },
    };
    const checked = await guardTurnOutput(ctx);
    assert.equal(checked.audit?.outcome, outcome);
    assert.equal(calls, 0);
    assert.equal(ctx.audit.correctionCount, 0);
    assert.deepEqual(ctx.audit.usageLogIds, []);
    assert.deepEqual(initial, before, 'validation leaves pre-turn state unchanged');
    const engine = new GameStateManager(world, initial);
    engine.applyEffects(checked.parsed.effects);
    assert.equal(engine.get('energy'), label === 'updated' ? 95 : 100);
  });
}

for (const [label, receipt] of [
  ['duplicate', `${none}\n${none}`],
  ['malformed', '<yumina-state version="1" status="updated" count="bogus" />'],
  ['malformed with a bracket command', '<yumina-state version="1" status="updated" count="bogus [energy: subtract 5]" />'],
] as const) {
  test(`${label} receipt stays invalid after player dialogue cleanup`, () => {
    const raw = `[SPEAKER:Mara:normal]\n"The gate is closed."\n[SPEAKER:You:normal]\nYou nod.\n${receipt}`;
    assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
    const result = clean(raw);
    assert.ok(result.raw.includes(receipt), 'invalid metadata is retained for strict validation');
    assert.doesNotMatch(result.raw, /\u0001\d+\u0001|YUMINA_LITERAL/);
    assert.equal(parseGuardedResponse(result.raw, world, state()).outcome, 'invalid');
  });
}

for (const [label, literal] of [
  ['inline', `The sample is ${none}`], ['quoted', `"${none}"`],
  ['fenced', `\`\`\`text\n${none}\n\`\`\``], ['inline code', `\`${none}\``],
] as const) {
  test(`${label} receipt example is never promoted into a real acknowledgment`, () => {
    const raw = `[SPEAKER:Mara:normal]\nThe gate is closed.\n${literal}\n[SPEAKER:You:normal]\nYou nod.`;
    assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
    assert.equal(parseGuardedResponse(clean(raw).raw, world, state()).outcome, 'invalid');
  });
}

test('nonterminal receipt stays invalid when its trailing player prose is removed', () => {
  const raw = `[SPEAKER:Mara:normal]\nThe gate is closed.\n[SPEAKER:You:normal]\n${none}\nYou nod.`;
  assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
  assert.equal(parseGuardedResponse(clean(raw).raw, world, state()).outcome, 'invalid');
});

test('an NPC-block nonterminal receipt is not promoted when a later player block is removed', () => {
  const raw = `[SPEAKER:Mara:normal]\n"The gate is closed."\n${none}\n[SPEAKER:You:normal]\nYou nod.`;
  assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
  assert.equal(parseGuardedResponse(clean(raw).raw, world, state()).outcome, 'invalid');
});

for (const tag of ['think', 'thinking', 'reasoning', 'game-state']) {
  test(`${tag}-hidden receipt cannot become an acknowledgment after player prose cleanup`, () => {
    const raw = `[SPEAKER:You:normal]\n<${tag}>\n${none}`;
    assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
    assert.equal(parseGuardedResponse(clean(raw).raw, world, state()).outcome, 'invalid');
  });
}

test('a hidden example receipt does not turn a later visible receipt into a duplicate', () => {
  const raw = `[SPEAKER:You:normal]\n<think>\n${none}\n</think>\nYou nod.\n[energy: subtract 5]\n${updated}`;
  assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'valid-updates');
  const parsed = parseGuardedResponse(clean(raw).raw, world, state());
  assert.equal(parsed.outcome, 'valid-updates');
  assert.deepEqual(parsed.effects, [{ variableId: 'energy', operation: 'subtract', value: 5 }]);
});

test('closed thinking metadata remains hidden and cannot acknowledge a reply', () => {
  const raw = `[SPEAKER:Mara:normal]\nThe gate is closed.\n[SPEAKER:You:normal]\n<think>\n${none}\n</think>\nYou nod.`;
  assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'invalid');
  assert.equal(parseGuardedResponse(clean(raw).raw, world, state()).outcome, 'invalid');
});

test('reasoning visibility cleanup preserves the legacy parser effects', () => {
  const raw = `[SPEAKER:You:normal]\n<think>\n[energy: subtract 80]\n</think>\nYou nod.\n[energy: subtract 5]\n${updated}`;
  const original = new ResponseParser().parse(raw);
  const result = purgePlayerAgency(original, raw);
  assert.deepEqual(result.parsed.effects, original.effects);
  assert.deepEqual(result.parsed.effects, [{ variableId: 'energy', operation: 'subtract', value: 5 }]);
  assert.equal(parseGuardedResponse(result.raw, world, state()).outcome, 'valid-updates');
});

test('an updated receipt before a command-only tail still validates its complete batch', () => {
  const raw = `[SPEAKER:You:normal]\nYou nod.\n${updated}\n[energy: subtract 5]`;
  assert.equal(parseGuardedResponse(raw, world, state()).outcome, 'valid-updates');
  const result = clean(raw);
  const parsed = parseGuardedResponse(result.raw, world, state());
  assert.equal(parsed.outcome, 'valid-updates');
  assert.deepEqual(parsed.effects, [{ variableId: 'energy', operation: 'subtract', value: 5 }]);
});
