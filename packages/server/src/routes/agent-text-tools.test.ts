import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { migrateWorldDefinition, worldEntrySchema, type WorldDefinition } from '@yumina/engine';
import { db } from '../db/index.js';
import { user, worlds, agentRuns, worldSnapshots, usageLogs } from '../db/schema.js';
import { captureStudioCreditWorldRevision, type StudioCreditCheckpoint } from '../lib/studio-credit-checkpoint.js';
import type { GenerateParams, LLMProvider, StreamChunk, ToolCall } from '../lib/llm/types.js';
import { CustomProvider } from '../lib/llm/custom.js';
import { STUDIO_TOOLS } from '../lib/studio-tools/tools.js';
import { harnessTurn } from '../lib/studio-tools/harness-notes.js';
import { streamAgentLoop } from './agent.js';

const mage = { id: 'lightning-affinity-mage', name: 'Lightning Affinity Mage', section: 'system-presets', role: 'character', tags: ['Characters'], content: 'A mage who channels raw lightning and wields a storm crystal staff.' };
const textCall = JSON.stringify({ tool: 'write_entry', arguments: mage });
const printedToolRequests = readFileSync(new URL('../test/fixtures/printed-tool-requests.txt', import.meta.url), 'utf8');
const malformedTextCall = '{"tool":"write_entry","arguments":{"id":"invalid-mage","content":"She calls them "my darling"."}}';
function events(raw: string, name: string): Array<Record<string, unknown>> {
  return raw.split('\n\n').filter(block => block.startsWith(`event: ${name}\n`)).map(block => JSON.parse(block.slice(block.indexOf('data: ') + 6)));
}

async function runFixture(first: StreamChunk[], message = 'Create a lightning affinity mage character.', maxIterations = 2, options: { stopReason?: string; replay?: boolean; replayText?: string; previousTextToolRetries?: number; alreadyApplied?: boolean; steps?: StreamChunk[][]; compatibleProvider?: LLMProvider; allowError?: boolean } = {}) {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: wid, version: '19.0.0', name: 'Text tool compatibility QA', description: '', author: 'test', entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  if (options.alreadyApplied) world.entries.push(worldEntrySchema.parse(mage));
  await db.insert(user).values({ id: uid, name: 'Tool compatibility', email: `${uid}@test.local` });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: world.name, status: 'draft', schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: rid, worldId: wid, userId: uid, model: 'text-tool-fixture', status: 'running' });
  const initialMessages: GenerateParams['messages'] = [{ role: 'user', content: message },
    ...Array.from({ length: options.previousTextToolRetries ?? 0 }, () => [
      { role: 'assistant' as const, content: malformedTextCall }, harnessTurn('text_tool_call'),
    ]).flat(),
  ];
  let creditResume: { checkpoint: StudioCreditCheckpoint; claimId: string } | undefined;
  if (options.replay) {
    const claimId = crypto.randomUUID(), scope = { runId: rid, worldId: wid, userId: uid };
    const revision = await captureStudioCreditWorldRevision(scope);
    const callId = `call_text_${rid}_0_0`;
    const checkpoint: StudioCreditCheckpoint = {
      version: 1, phase: 'generated', messages: initialMessages, iteration: 0,
      worldRevision: revision.revision, requiredCredits: 0, claim: { id: claimId, claimedAt: new Date().toISOString() },
      generated: { textContent: options.replayText ?? textCall, toolCalls: [], cost: 0, settled: true, usageLogId: crypto.randomUUID(),
        stopReason: 'end_turn', usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        ...(options.alreadyApplied ? { progress: { [`${callId}:0`]: { tool_call_id: callId, name: 'write_entry', status: 'success' as const, result: { status: 'OK', id: mage.id } } } } : {}),
      },
    };
    await db.update(agentRuns).set({ creditCheckpoint: checkpoint as unknown as Record<string, unknown> }).where(eq(agentRuns.id, rid));
    creditResume = { checkpoint, claimId };
  }
  const requests: GenerateParams[] = [];
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    requests.push(request);
    if (options.compatibleProvider) { yield* options.compatibleProvider.generateStream(request); return; }
    if (options.steps?.[requests.length - 1]) yield* options.steps[requests.length - 1]!;
    else if (requests.length === 1) yield* first;
    else yield { type: 'text', content: request.messages.some(item => item.role === 'tool') ? 'Created the lightning mage.' : 'No changes made.' };
    yield { type: 'done', content: '', stopReason: requests.length === 1 ? options.stopReason ?? 'end_turn' : 'end_turn' };
  } };
  const app = new Hono();
  app.get('/test', c => streamAgentLoop(c, { runId: rid, conversationId: rid, worldId: wid, userId: uid, world,
    messages: initialMessages, model: 'text-tool-fixture', provider, isByok: true, apiKeyTier: 'byok', unlimited: true, iteration: 0, maxIterations, tools: STUDIO_TOOLS, creditResume }));
  try {
    const response = await app.request('/test');
    const stream = await response.text();
    assert.equal(response.status, 200);
    if (!options.allowError) assert.doesNotMatch(stream, /event: error/);
    const saved = (await db.select().from(worlds).where(eq(worlds.id, wid)))[0]!.schema as unknown as WorldDefinition;
    const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!;
    const snapshots = await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, rid));
    const usage = await db.select().from(usageLogs).where(eq(usageLogs.userId, uid));
    return { saved, run, snapshots, requests, stream, usage };
  } finally { await db.delete(user).where(eq(user.id, uid)); }
}

test('standalone JSON returned as text creates the requested character through the normal tool flow', async () => {
  const result = await runFixture([{ type: 'text', content: textCall }]);
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.saved.entries.find(entry => entry.id === mage.id)!.content, mage.content);
  assert.equal(result.snapshots.length, 1, 'The ordinary undo snapshot is retained');
  assert.equal(result.run.status, 'completed'); assert.equal(result.requests.length, 2, 'One write step followed by its normal completion reply');
  const next = result.requests[1]!.messages;
  assert.ok(next.some(item => item.role === 'tool'), 'The model receives the execution result');
  assert.ok(next.some(item => item.role === 'assistant' && item.tool_calls?.[0]?.function.name === 'write_entry'), 'History contains a canonical tool call');
  assert.equal(events(result.stream, 'applied').length, 1);
  assert.equal(events(result.stream, 'tool_end')[0]?.name, 'write_entry');
  assert.ok(events(result.stream, 'assistant_turn_commit').some(turn => turn.textContent === '' && Array.isArray(turn.writeToolCalls)));
  assert.ok(!events(result.stream, 'text').some(event => String(event.content).includes('"tool"')), 'The request is not displayed as JSON chat text');
  assert.ok(!JSON.stringify(result.run.committedTurns.map(turn => turn.textContent)).includes('"tool"'));
});

test('native tool calls retain priority and are not executed again from matching text', async () => {
  const native: ToolCall = { id: 'native-mage', type: 'function', function: { name: 'write_entry', arguments: JSON.stringify(mage) } };
  const result = await runFixture([{ type: 'text', content: textCall }, { type: 'tool_call_end', content: '', toolCall: native }]);
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.snapshots.length, 1); assert.equal(events(result.stream, 'applied').length, 1);
  const calls = result.requests[1]!.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
  assert.deepEqual(calls, [native]);
});

test('prose containing a JSON example stays text and does not modify the world', async () => {
  const prose = `Here is an example of the tool format:\n\`\`\`json\n${textCall}\n\`\`\``;
  const result = await runFixture([{ type: 'text', content: prose }], 'Explain what a tool request looks like.', 1);
  assert.equal(result.saved.entries.length, 0); assert.equal(result.snapshots.length, 0);
  assert.equal(events(result.stream, 'tool_end').length, 0);
  assert.equal(events(result.stream, 'text').map(event => event.content).join(''), prose);
});

test('a text tool request split across streaming chunks is recovered without exposing partial JSON', async () => {
  const input = `\`\`\`json\n${textCall}\n\`\`\``;
  const result = await runFixture([{ type: 'text', content: input.slice(0, 1) }, { type: 'text', content: input.slice(1, 24) }, { type: 'text', content: input.slice(24) }]);
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(events(result.stream, 'applied').length, 1);
  assert.deepEqual(events(result.stream, 'text').map(event => event.content), ['Created the lightning mage.']);
});

test('JSON-looking ordinary answers and documentation envelopes reach chat unchanged', async () => {
  for (const text of ['{This is explanatory prose, not JSON.}', JSON.stringify({ example: JSON.parse(textCall) })]) {
    const result = await runFixture([{ type: 'text', content: text.slice(0, 1) }, { type: 'text', content: text.slice(1) }], 'Explain this format.', 1);
    assert.equal(result.saved.entries.length, 0);
    assert.equal(events(result.stream, 'text').map(event => event.content).join(''), text);
    assert.equal(events(result.stream, 'tool_end').length, 0);
  }
});

test('recovered requests still receive ordinary argument validation errors', async () => {
  const result = await runFixture([{ type: 'text', content: JSON.stringify({ tool: 'write_entry', arguments: { content: 'No valid entry ID.' } }) }]);
  assert.equal(result.saved.entries.length, 0); assert.equal(result.snapshots.length, 0);
  assert.equal(events(result.stream, 'applied').length, 0);
  const error = result.requests[1]!.messages.find(message => message.role === 'tool');
  assert.ok(error); assert.match(String(error.content), /error|requires/i);
});

test('truncated output and summary output are never recovered as executable calls', async () => {
  for (const options of [{ message: 'Create a character.', stopReason: 'max_tokens' }, { message: '/summarize', stopReason: 'end_turn' }]) {
    const result = await runFixture([{ type: 'text', content: textCall }], options.message, 1, { stopReason: options.stopReason });
    assert.equal(result.saved.entries.length, 0); assert.equal(events(result.stream, 'applied').length, 0);
    assert.equal(events(result.stream, 'tool_end').length, 0);
  }
});

test('read and write requests returned as tagged text continue through the normal agent loop', async () => {
  const result = await runFixture([], 'Inspect the world, then create a character named Lightning Affinity Mage.', 3, { steps: [
    [{ type: 'text', content: '<tool_call>{"name":"list_templates","arguments":{}}</tool_call>' }],
    [{ type: 'text', content: `<tool_call>${textCall}</tool_call>` }],
  ] });
  assert.equal(result.requests.length, 3); assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.deepEqual(events(result.stream, 'tool_end').map(event => event.name), ['list_templates', 'write_entry']);
});

test('replaying a generated text request applies it without another provider call or usage record', async () => {
  const result = await runFixture([], 'Create a character named Lightning Affinity Mage.', 1, { replay: true });
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.requests.length, 0); assert.equal(result.usage.length, 0);
  assert.equal(result.snapshots.length, 1); assert.equal(events(result.stream, 'applied').length, 1);
});

test('replaying an already applied text request skips the write with the same progress key', async () => {
  const result = await runFixture([], 'Create a lightning mage.', 1, { replay: true, alreadyApplied: true });
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.requests.length, 0); assert.equal(result.usage.length, 0);
  assert.equal(result.snapshots.length, 0); assert.equal(events(result.stream, 'applied').length, 0);
});

test('an OpenAI-compatible endpoint emitting JSON in SSE content creates the character and accepts canonical tool history', async t => {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 2) return Response.json({ message: "messages.2.assistant.reasoning_content: property 'messages.2.assistant.reasoning_content' is unsupported" }, { status: 400 });
    const content = requests.length === 1 ? textCall : 'Created the lightning mage.';
    return new Response([
      ...(requests.length === 1 ? ['data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Plan the mage entry.' } }] })] : []),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(0, 3) } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(3) } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = await runFixture([], undefined, 2, { compatibleProvider: new CustomProvider('fixture-only', 'https://compatible.example/v1') });
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(requests.length, 3); assert.equal(events(result.stream, 'applied').length, 1);
  const history = requests[1]!.messages as Array<{ role: string; tool_calls?: ToolCall[]; tool_call_id?: string }>;
  const call = history.find(message => message.role === 'assistant' && message.tool_calls)?.tool_calls?.[0];
  assert.ok(call); assert.equal(call.function.name, 'write_entry');
  assert.ok(history.some(message => message.role === 'tool' && message.tool_call_id === call.id));
  const retryHistory = requests[2]!.messages as Array<Record<string, unknown>>;
  assert.ok(retryHistory.every(message => !Object.hasOwn(message, 'reasoning_content')));
  assert.equal(result.usage.length, 2, 'Only successful generation usage is recorded');
  assert.deepEqual(events(result.stream, 'text').map(event => event.content).join(''), 'Created the lightning mage.');
});

test('recovered ask_user calls pause without executing a combined write', async () => {
  const output = JSON.stringify([{ tool: 'ask_user', arguments: { question: 'Which opening should contain this character?' } }, JSON.parse(textCall)]);
  const result = await runFixture([{ type: 'text', content: output }]);
  assert.equal(result.saved.entries.length, 0); assert.equal(result.run.status, 'awaiting_user');
  assert.equal(result.requests.length, 1); assert.equal(events(result.stream, 'applied').length, 0);
  assert.equal(events(result.stream, 'done')[0]?.status, 'awaiting_user');
  assert.ok(events(result.stream, 'assistant_turn_commit').some(turn => String(turn.textContent).includes('Which opening')));
});

test('unrecoverable printed tool requests retry actual calls and then end in an execution error', async () => {
  const step: StreamChunk[] = [{ type: 'text', content: malformedTextCall }];
  const result = await runFixture([], 'Create the Dramatic Heroine and Seira characters.', 10, { steps: [step, step, step], allowError: true });
  assert.equal(result.run.status, 'error');
  assert.equal(result.requests.length, 3, 'Retries are bounded even with unused iterations');
  assert.deepEqual(result.requests.map(request => request.toolChoice), ['auto', 'required', 'required']);
  assert.equal(result.saved.entries.length, 0);
  assert.equal(result.snapshots.length, 0);
  assert.equal(events(result.stream, 'applied').length, 0);
  assert.equal(events(result.stream, 'error')[0]?.code, 'TOOL_CALL_NOT_EXECUTED');
  assert.match(result.run.error ?? '', /tool request.*not executed/i);
  assert.ok(!events(result.stream, 'done').some(event => event.status === 'completed'));
  assert.ok(result.run.committedTurns.every(turn => turn.lane === 'step'), 'Unexecuted requests must not become answers in cross-run history');
});

test('a malformed printed request can recover on the required retry and return to ordinary completion', async () => {
  const native: ToolCall = { id: 'corrected-mage', type: 'function', function: { name: 'write_entry', arguments: JSON.stringify(mage) } };
  const result = await runFixture([], undefined, 4, { steps: [
    [{ type: 'text', content: malformedTextCall }],
    [{ type: 'tool_call_end', content: '', toolCall: native }],
  ] });
  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.requests.map(request => request.toolChoice), ['auto', 'required', 'auto']);
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.snapshots.length, 1);
  assert.equal(events(result.stream, 'applied').length, 1);
  assert.equal(result.run.committedTurns[0]?.lane, 'step');
});

test('a prior real tool call does not conceal later unexecuted requests', async () => {
  const native: ToolCall = { id: 'earlier-mage', type: 'function', function: { name: 'write_entry', arguments: JSON.stringify(mage) } };
  const step: StreamChunk[] = [{ type: 'text', content: malformedTextCall }];
  const result = await runFixture([], undefined, 6, { steps: [
    [{ type: 'tool_call_end', content: '', toolCall: native }], step, step, step,
  ], allowError: true });
  assert.equal(result.run.status, 'error');
  assert.equal(result.requests.length, 4);
  assert.deepEqual(result.requests.map(request => request.toolChoice), ['auto', 'auto', 'required', 'required']);
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1, 'Earlier successful writes stay saved');
  assert.equal(result.snapshots.length, 1);
  assert.equal(events(result.stream, 'error')[0]?.code, 'TOOL_CALL_NOT_EXECUTED');
});

test('an unexecuted request at the iteration limit errors instead of completing', async () => {
  const result = await runFixture([{ type: 'text', content: malformedTextCall }], undefined, 1, { allowError: true });
  assert.equal(result.run.status, 'error');
  assert.equal(result.requests.length, 1);
  assert.equal(events(result.stream, 'error')[0]?.code, 'TOOL_CALL_NOT_EXECUTED');
  assert.equal(result.saved.entries.length, 0);
});

test('a prose example remains an ordinary answer without required tool retries', async () => {
  const result = await runFixture([{ type: 'text', content: `Here is an example of the tool format:\n\`\`\`json\n${textCall}\n\`\`\`` }], 'Explain what a tool request looks like.', 4);
  assert.equal(result.run.status, 'completed');
  assert.ok(result.requests.every(request => request.toolChoice === 'auto'));
  assert.equal(result.saved.entries.length, 0);
  assert.equal(events(result.stream, 'error').length, 0);
});

test('a saved malformed request ends in an error without re-billing or leaving a resumable failed result', async () => {
  const result = await runFixture([], undefined, 1, { replay: true, replayText: malformedTextCall, allowError: true });
  assert.equal(result.run.status, 'error');
  assert.equal(result.run.creditCheckpoint, null);
  assert.equal(result.requests.length, 0);
  assert.equal(result.usage.length, 0);
  assert.equal(result.saved.entries.length, 0);
  assert.equal(events(result.stream, 'error')[0]?.code, 'TOOL_CALL_NOT_EXECUTED');
});

test('an OpenAI-compatible endpoint receives required tool choice and executes the corrected native call', async t => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const native = bodies.length === 2;
    const delta = native ? { tool_calls: [{ index: 0, id: 'compatible-corrected-mage', type: 'function', function: { name: 'write_entry', arguments: JSON.stringify(mage) } }] }
      : { content: bodies.length === 1 ? malformedTextCall : 'Created the lightning mage.' };
    return new Response([
      'data: ' + JSON.stringify({ choices: [{ delta }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: native ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = await runFixture([], undefined, 4, { compatibleProvider: new CustomProvider('fixture-only', 'https://compatible.example/v1') });
  assert.deepEqual(bodies.map(body => body.tool_choice), ['auto', 'required', 'auto']);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.saved.entries.filter(entry => entry.id === mage.id).length, 1);
  assert.equal(result.snapshots.length, 1);
  assert.equal(events(result.stream, 'applied').length, 1);
  const history = bodies[2]!.messages as Array<{ role: string; tool_call_id?: string }>;
  assert.ok(history.some(message => message.role === 'tool' && message.tool_call_id === 'compatible-corrected-mage'));
});

test('resuming a failed text request retains the earlier retry budget', async () => {
  const result = await runFixture([], undefined, 10, {
    replay: true, replayText: malformedTextCall, previousTextToolRetries: 1, allowError: true,
    steps: [[{ type: 'text', content: malformedTextCall }]],
  });
  assert.equal(result.run.status, 'error');
  assert.equal(result.requests.length, 1, 'One retry was already scheduled before the pause');
  assert.equal(result.requests[0]!.toolChoice, 'required');
  assert.equal(result.run.creditCheckpoint, null);
  assert.equal(result.saved.entries.length, 0);
  assert.equal(events(result.stream, 'error')[0]?.code, 'TOOL_CALL_NOT_EXECUTED');
});

test('adjacent valid printed writes execute directly with no request for the model to call tools again', async () => {
  const second = { ...mage, id: 'second-lightning-mage' };
  const batch = `1. Write both entries.\n\n${textCall}\n${JSON.stringify({ tool: 'write_entry', arguments: second })}\n${textCall}`;
  const result = await runFixture([{ type: 'text', content: batch }], undefined, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.toolChoice, 'auto');
  assert.equal(result.run.status, 'completed');
  assert.equal(result.saved.entries.length, 2);
  assert.equal(result.snapshots.length, 1, 'The batch uses the normal single undo snapshot');
  assert.equal(events(result.stream, 'applied').length, 2);
  assert.deepEqual(events(result.stream, 'tool_end').map(event => event.name), ['write_entry', 'write_entry']);
});

test('valid printed requests in the pasted response execute even though the heroine request is malformed', async () => {
  const result = await runFixture([{ type: 'text', content: printedToolRequests }], 'Create the Dramatic Heroine and Seira characters.', 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.saved.entries.find(entry => entry.id === 'seira')?.content, 'A character named Seira.');
  assert.ok(!result.saved.entries.some(entry => entry.id === 'dramatic-heroine'));
  assert.equal(result.snapshots.length, 1);
  assert.equal(events(result.stream, 'applied').length, 1);
  assert.match(result.run.committedTurns.map(turn => turn.textContent).join(''), /invalid.*not executed/i);
});

test('a saved printed batch executes directly and skips the write already recorded in its checkpoint', async () => {
  const second = { ...mage, id: 'second-lightning-mage' };
  const batch = `${textCall}\n${JSON.stringify({ tool: 'write_entry', arguments: second })}`;
  const result = await runFixture([], undefined, 1, { replay: true, replayText: batch, alreadyApplied: true });
  assert.equal(result.run.status, 'completed');
  assert.equal(result.requests.length, 0);
  assert.equal(result.usage.length, 0);
  assert.equal(result.saved.entries.length, 2);
  assert.equal(result.snapshots.length, 0, 'Recorded progress prevents creating another undo snapshot');
  assert.equal(events(result.stream, 'applied').length, 1);
});

test('an OpenAI-compatible stream with adjacent text requests executes them without a tool-call retry', async t => {
  const bodies: Array<Record<string, unknown>> = [];
  const batch = `${textCall}\n${JSON.stringify({ tool: 'write_entry', arguments: { ...mage, id: 'second-lightning-mage' } })}`;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: batch.slice(0, 8) } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: batch.slice(8) } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = await runFixture([], undefined, 1, { compatibleProvider: new CustomProvider('fixture-only', 'https://compatible.example/v1') });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.tool_choice, 'auto');
  assert.equal(result.run.status, 'completed');
  assert.equal(result.saved.entries.length, 2);
  assert.equal(events(result.stream, 'applied').length, 2);
  assert.equal(result.usage.length, 1);
});
