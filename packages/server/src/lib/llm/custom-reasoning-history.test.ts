import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomProvider } from './custom.js';
import type { GenerateParams, StreamChunk } from './types.js';

const rejection = { message: "messages.2.assistant.reasoning_content: property 'messages.2.assistant.reasoning_content' is unsupported", type: 'invalid_request_error', param: 'validation_error', code: 'wrong_api_format' };
const params: GenerateParams = {
  model: 'custom/strict-model',
  messages: [
    { role: 'system', content: 'Help the creator.' }, { role: 'user', content: 'Create a mage.' },
    { role: 'assistant', content: '', reasoning_content: 'Plan the entry.', tool_calls: [{ id: 'mage-write', type: 'function', function: { name: 'write_entry', arguments: '{"id":"mage","content":"Lightning."}' } }] },
    { role: 'tool', tool_call_id: 'mage-write', content: '{"status":"OK"}' },
  ],
};
const reply = () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Created the mage.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider: CustomProvider, request = params) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.generateStream(request)) chunks.push(chunk);
  return chunks;
}

test('retries a rejected nested assistant reasoning field without changing tool history or local messages', async t => {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return requests.length === 1 ? Response.json(rejection, { status: 400 }) : reply();
  });
  const original = JSON.stringify(params.messages);
  const provider = new CustomProvider('fixture-only', 'https://compatible.example/v1');
  const chunks = await collect(provider);
  assert.equal(chunks.filter(chunk => chunk.type === 'error').length, 0);
  assert.equal(requests.length, 2);
  const expected = structuredClone(requests[0]!);
  const messages = expected.messages as Array<Record<string, unknown>>;
  delete messages[2]!.reasoning_content;
  assert.deepEqual(requests[1], expected, 'Only the rejected nested field is removed');
  assert.equal(JSON.stringify(params.messages), original, 'Canonical reasoning and tool history remain intact');
  await collect(provider); await collect(provider, { ...params, model: 'custom/supporting-model' });
  assert.equal(requests.length, 4);
  assert.ok(!('reasoning_content' in (requests[2]!.messages as Array<Record<string, unknown>>)[2]!));
  assert.equal((requests[3]!.messages as Array<Record<string, unknown>>)[2]!.reasoning_content, 'Plan the entry.');
});

test('keeps supported reasoning history and does not retry unrelated field errors', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
  const provider = new CustomProvider('fixture-only', 'https://compatible.example/v1');
  assert.equal((await collect(provider)).filter(chunk => chunk.type === 'error').length, 0);
  assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ message: "property 'tool_calls' is unsupported; reasoning_content is present" }, { status: 400 }); });
  const chunks = await collect(provider);
  assert.equal(calls, 2); assert.equal(chunks.at(-1)?.type, 'error');
});

test('nested reasoning compatibility honors single-attempt requests and stops after a failed retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(rejection, { status: 400 }); });
  const provider = new CustomProvider('fixture-only', 'https://compatible.example/v1');
  const single = await collect(provider, { ...params, singleAttempt: true });
  assert.equal(calls, 1); assert.equal(single.at(-1)?.type, 'error');
  const retried = await collect(provider); assert.equal(calls, 3); assert.equal(retried.at(-1)?.type, 'error');
});

test('a nested reasoning rejection without that field never strips the entire messages array', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ message: "Unsupported parameter: 'messages.2.assistant.reasoning_content'" }, { status: 400 }); });
  const chunks = await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), { ...params, messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(calls, 1); assert.equal(chunks.at(-1)?.type, 'error');
});
