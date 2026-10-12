import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponseParser, StructuredResponseParser } from '@yumina/engine';
import { purgePlayerAgency } from './player-agency.js';
const parse = (raw: string) => new StructuredResponseParser().isStructuredResponse(raw) ? new StructuredResponseParser().parse(raw) : new ResponseParser().parse(raw);
const purge = (raw: string, aliases: string[] = [], cast: string[] = []) => purgePlayerAgency(parse(raw), raw, aliases, cast);

test('only explicit AI control retains recurring persona speech and actions', () => {
  const raw = '[SPEAKER:{{user}}:happy] "Hello."\n[SPEAKER:Guide:normal] "Welcome."\n[SPEAKER:Narrator:normal] *{{user}} smiles.*\n[SPEAKER:{{user}}:normal] "Thank you."\n[CHOICES:["Ask about the academy","Wait"]]';
  const result = purgePlayerAgency(parse(raw), raw, [], [], 'ai');
  assert.match(result.parsed.cleanText, /Hello\./);
  assert.match(result.parsed.cleanText, /Thank you\./);
  assert.match(result.raw, /\{\{user\}\} smiles/);
  assert.deepEqual(result.parsed.choices, ['Ask about the academy', 'Wait']);
});

test('manual, assisted and invalid modes keep the player agency guard', () => {
  const raw = '[SPEAKER:{{user}}:normal] "I agree."\n[SPEAKER:Guide:normal] "Welcome."';
  for (const mode of [undefined, 'player', 'assisted', 'autonomous', true]) {
    const result = purgePlayerAgency(parse(raw), raw, [], [], mode as any);
    assert.doesNotMatch(result.raw, /I agree/);
    assert.match(result.parsed.cleanText, /Welcome/);
  }
});

test('automatically removes player speech, thoughts and actions while retaining NPC text and choices', () => {
  for (const line of ['[SPEAKER:{{user}}:normal] "Hello."', '[speaker: You] Hello.', '*{{user}} agrees to the offer.*', '*{{user}} thought about leaving.*', '*Robin walks away.*', 'You decide to leave.', '*{{user}} is thinking about leaving.*', '*{{user}} is walking toward the gate.*', '*{{user}} shuffles toward the gate.*', '*The bell rings, and {{user}} twirls a wand.*']) {
    const raw = `${line}\n[SPEAKER:Evelia:normal] "The gate is open."\n[CHOICES:["{{user}} walks to the gate","Ask the guide"]]`;
    const result = purge(raw, ['Robin']);
    assert.doesNotMatch(result.raw, /Hello\.|agrees|thought|walks away|decide to leave|thinking|walking|shuffles|twirls/);
    assert.match(result.parsed.cleanText, /The gate is open/);
    assert.deepEqual(result.parsed.choices, ['{{user}} walks to the gate', 'Ask the guide']);
    assert.ok(result.removed);
  }
});
test('NPC speech, offered choices and passive references to the persona are preserved', () => {
  for (const raw of ['[SPEAKER:Evelia:normal] "Do you agree?"', '[SPEAKER:Narrator:normal] *Evelia offers {{user}} a seat.*', '*{{user}} is surrounded by falling snow.*', '[CHOICES: ["{{user}} walks to the gate", "Ask the guide"]]', '[SPEAKER:Evelia:normal] "You look lost."', '[SPEAKER:Evelia:normal] You look lost.']) {
    const result = purge(raw);
    assert.equal(result.raw, raw);
    assert.equal(result.removed, false);
  }
});
test('same-named NPC references are preserved', () => {
  const raw = '[SPEAKER:Robin:normal] "Hello."\n*Robin walks to the gate.*';
  assert.equal(purge(raw, ['Robin'], ['Robin']).raw, raw);
});
test('player dialogue blocks end at NPC/narrator markers, including inline markers', () => {
  const raw = '[speaker: You]\n"I agree."\n"Let us go."\nNarrator: *The bell rings.*\n[SPEAKER:Evelia:normal] "Good." [SPEAKER:{{user}}:normal] "Yes." [SPEAKER:Guide:normal] "Welcome."';
  const result = purge(raw);
  assert.doesNotMatch(result.raw, /I agree|Let us go|Yes\./);
  assert.match(result.raw, /The bell rings/);
  assert.match(result.raw, /Welcome/);
  assert.notEqual(result.parsed.speaker, 'You');
});
test('JSON narrative and segment presentation are purged without losing state/audio/choices', () => {
  const raw = JSON.stringify({ narrative: '*{{user}} steps forward.*\n*The bell rings.*', status: 'updated', stateChanges: [{ variableId: 'hp', operation: 'subtract', value: 2 }, { variableId: 'segments', operation: 'set', value: [{ speaker: '{{user}}', text: 'Hello.' }, { speaker: 'Guide', text: 'Welcome.' }, { speaker: 'Narrator', text: '{{user}} decides to go.' }] }], choices: ['Walk to the gate'], audioEffects: [{ trackId: 'bell', action: 'play' }] });
  const result = purge(raw);
  const json = JSON.parse(result.raw);
  assert.doesNotMatch(result.raw, /steps forward|Hello\.|decides to go/);
  assert.equal(json.status, 'updated');
  assert.deepEqual(json.stateChanges[0], { variableId: 'hp', operation: 'subtract', value: 2 });
  assert.deepEqual(json.stateChanges[1].value, [{ speaker: 'Guide', text: 'Welcome.' }]);
  assert.deepEqual(result.parsed.effects, json.stateChanges);
  assert.deepEqual(result.parsed.choices, ['Walk to the gate']);
  assert.deepEqual(result.parsed.audioEffects, [{ trackId: 'bell', action: 'play' }]);
});
test('inline state commands and receipts survive removed action lines', () => {
  const raw = '*{{user}} raises a hand.* [hp: subtract 2]\n*The bell rings.*\n<state-updates status="updated" />';
  const result = purge(raw);
  assert.doesNotMatch(result.raw, /raises a hand/);
  assert.match(result.raw, /\[hp: subtract 2\]/);
  assert.match(result.raw, /<state-updates/);
  assert.deepEqual(result.parsed.effects, [{ variableId: 'hp', operation: 'subtract', value: 2 }]);
});
test('fully purged prose gets a narrator pause so the turn remains playable', () => {
  const result = purge('[SPEAKER:{{user}}:normal] "I agree."\n[CHOICES:["Ask the guide"]]');
  assert.match(result.parsed.cleanText, /The scene pauses/);
  assert.equal(result.parsed.speaker, 'narrator');
  assert.deepEqual(result.parsed.choices, ['Ask the guide']);
  assert.equal(purge(result.raw).raw, result.raw);
});

test('untagged action lines after NPC dialogue are still removed', () => {
  const result = purge('[SPEAKER:Guide:normal] "Welcome."\n{{user}} walks into the hall.\nThe bell rings.');
  assert.doesNotMatch(result.raw, /walks into/);
  assert.doesNotMatch(result.parsed.cleanText, /walks into/);
  assert.match(result.parsed.cleanText, /Welcome/);
});

test('truncated structured envelopes do not retain player presentation in raw history', () => {
  const raw = JSON.stringify({ narrative: '*The bell rings.*', stateChanges: [{ variableId: 'segments', operation: 'set', value: [{ speaker: '{{user}}', text: 'I will go.' }, { speaker: 'Guide', text: 'Welcome.' }] }] }).slice(0, -1);
  const result = purge(raw);
  assert.doesNotMatch(result.raw, /I will go/);
  assert.deepEqual(result.parsed.effects[0]?.value, [{ speaker: 'Guide', text: 'Welcome.' }]);
});

test('a generic NPC tag cannot disguise speech explicitly attributed to the player', () => {
  for (const introduction of ['*{{user}} speaks with clear confidence.*', '*{{user}} raises a hand toward the noble, speaking clearly.*']) {
    const result = purge(`${introduction}\n\n[SPEAKER:NPC:normal] "I accept your challenge. Let us duel."\n[SPEAKER:NPC:smug:male:noble-student] "Prepare yourself."\n[CHOICES:["Wait","Ask the referee"]]`);
    assert.doesNotMatch(result.parsed.cleanText, /I accept your challenge/);
    assert.doesNotMatch(result.raw, /I accept your challenge/);
    assert.match(result.parsed.cleanText, /Prepare yourself/);
    assert.deepEqual(result.parsed.choices, ['Wait', 'Ask the referee']);
  }
});

test('established NPC speech is retained after a removed player action', () => {
  const result = purge('*{{user}} speaks with clear confidence.*\n[SPEAKER:NPC:normal:male:academy-clerk] "Sign here."');
  assert.match(result.parsed.cleanText, /Sign here/);
});

test('removed player narration cannot promote a literal code example into a command', () => {
  const result = purge('The plaque shows `[hp: +1]` and {{user}} walks away.');
  assert.doesNotMatch(result.raw, /\[hp: \+1\]/);
  assert.equal(new ResponseParser().parse(result.raw).effects.length, 0);
});

test('NPC speech cues and multiline NPC quotes remain NPC dialogue', () => {
  const result = purge('*Sera speaks softly as {{user}} opens the door.*\n[SPEAKER:NPC:normal] "Please sit."');
  assert.match(result.parsed.cleanText, /Please sit/);
  const multiline = '[SPEAKER:Maeve:normal]\n“Please sit.\nYou look tired.”';
  assert.equal(purge(multiline).parsed.cleanText, new ResponseParser().parse(multiline).cleanText);
});

test('removing all visible speech supplies a readable pause even if narrator headers remain', () => {
  const result = purge('[SPEAKER:Narrator:normal]\n*{{user}} speaks.*\n[SPEAKER:NPC:normal] "I agree."');
  assert.match(result.parsed.cleanText, /The scene pauses/);
});
