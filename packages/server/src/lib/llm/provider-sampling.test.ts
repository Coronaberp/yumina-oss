import assert from 'node:assert/strict';
import test from 'node:test';
import { createByokProvider, createProvider, type ProviderName } from './provider-factory.js';
import type { GenerateParams } from './types.js';
import { CustomProvider } from './custom.js';

const cases = [
  { provider: 'custom', model: 'custom/classic-model' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
  { provider: 'openai', model: 'openai/gpt-4o' },
  { provider: 'google', model: 'google/gemini-2.5-flash' },
  { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-5' },
  { provider: 'ollama', model: 'ollama/llama3' },
] as const;

function reply(provider: ProviderName) {
  if (provider === 'google') return Response.json({ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] });
  if (provider === 'anthropic') return Response.json({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  if (provider === 'ollama') return Response.json({ message: { content: 'Hello' }, done: true, done_reason: 'stop' });
  return Response.json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
}

for (const entry of cases) {
  test(`${entry.provider} sends profile creativity overrides and legacy defaults without changing chat preferences`, async t => {
    let body: any;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return reply(entry.provider); });
    for (const metadata of [null, { temperature: 0, topP: 0.85, topK: 60 }]) {
      const provider = createByokProvider(entry.provider, entry.provider === 'ollama' ? 'http://localhost:11434' : 'fixture-only', 'https://compatible.example/v1', metadata);
      const params: GenerateParams = { model: entry.model, messages: [{ role: 'user', content: 'Tell a story' }], stream: false, disableReasoning: true, singleAttempt: true, temperature: 1.1, topP: 1, topK: 200 };
      const chunks = [];
      for await (const chunk of provider.generateStream(params)) chunks.push(chunk);
      assert.equal(chunks.some(chunk => chunk.type === 'error'), false, JSON.stringify(chunks));
      const settings = entry.provider === 'google' ? body.generationConfig : entry.provider === 'ollama' ? body.options : body;
      assert.equal(settings.temperature, metadata ? 0 : 0.8);
      assert.equal(settings[entry.provider === 'google' ? 'topP' : 'top_p'], metadata ? 0.85 : 0.95);
      if (entry.provider !== 'openai') assert.equal(settings[entry.provider === 'google' ? 'topK' : 'top_k'], metadata ? 60 : 40);
      else assert.equal('top_k' in settings, false);
      assert.equal(params.temperature, 1.1);
      assert.equal(params.topP, 1);
      assert.equal(params.topK, 200);
    }
  });
}

test('requests without a profile retain their sampling settings', async t => {
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return reply('custom'); });
  for await (const _ of createProvider('custom', 'fixture-only', 'https://compatible.example/v1').generateStream({ model: 'custom/classic-model', messages: [{ role: 'user', content: 'Hi' }], stream: false, temperature: 0.3, topP: 0.7, topK: 20 })) {}
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.7);
  assert.equal(body.top_k, 20);
});

test('custom connection tests use profile creativity settings', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply('custom'); });
  assert.equal((await new CustomProvider('fixture-only', 'https://compatible.example/v1', { temperature: 0.6, topP: 0.9, topK: 60 }).sendTestMessage('classic-model')).ok, true);
  assert.equal(bodies[0].temperature, 0.6);
  assert.equal(bodies[0].top_p, 0.9);
  assert.equal(bodies[0].top_k, 60);
});

test('custom streaming retries unsupported top K while keeping the other profile settings', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1
      ? Response.json({ error: { message: "Unsupported parameter: 'top_k'" } }, { status: 400 })
      : new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const chunks = [];
  for await (const chunk of createByokProvider('custom', 'fixture-only', 'https://compatible.example/v1', { temperature: 0.6, topP: 0.9, topK: 60 }).generateStream({ model: 'custom/classic-model', messages: [{ role: 'user', content: 'Hi' }], stream: true })) chunks.push(chunk);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].top_k, 60);
  assert.equal('top_k' in bodies[1], false);
  assert.equal(bodies[1].temperature, 0.6);
  assert.equal(bodies[1].top_p, 0.9);
  assert.equal(chunks.at(-1)?.type, 'done');
});
