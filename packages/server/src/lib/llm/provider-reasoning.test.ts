import assert from 'node:assert/strict';
import test from 'node:test';
import { createByokProvider, createProvider, type ProviderName } from './provider-factory.js';
import { CustomProvider } from './custom.js';
import type { GenerateParams } from './types.js';

const cases: Array<{ provider: ProviderName; model: string; effort: (body: any) => unknown }> = [
  { provider: 'custom', model: 'custom/qwen3.8', effort: body => body.reasoning_effort },
  { provider: 'openai', model: 'openai/gpt-5.1', effort: body => body.reasoning_effort },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4', effort: body => body.reasoning?.effort },
  { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6', effort: body => body.output_config?.effort },
  { provider: 'google', model: 'google/gemini-3.7-flash', effort: body => body.generationConfig?.thinkingConfig?.thinkingLevel },
  { provider: 'ollama', model: 'ollama/gpt-oss:20b', effort: body => body.think },
];

function response(provider: ProviderName): Response {
  if (provider === 'google') return Response.json({ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] });
  if (provider === 'anthropic') return Response.json({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  if (provider === 'ollama') return Response.json({ message: { content: 'Hello' }, done: true, done_reason: 'stop' });
  return Response.json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
}

for (const entry of cases) {
  for (const effort of [undefined, 'high'] as const) {
    test(`${entry.provider} sends ${effort ?? 'low by default'} and honors the saved endpoint over chat defaults`, async t => {
      let body: any;
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return response(entry.provider);
      });
      const provider = createByokProvider(entry.provider, entry.provider === 'ollama' ? 'http://localhost:11434' : 'fixture-only', 'https://compatible.example/v1', effort ? { reasoningEffort: effort } : null);
      const chunks = [];
      const params: GenerateParams = { model: entry.model, messages: [{ role: 'user', content: 'Hi' }], stream: false, maxTokens: 12000, singleAttempt: true };
      if (effort) params.reasoningEffort = 'low';
      for await (const chunk of provider.generateStream(params)) chunks.push(chunk);
      assert.equal(chunks.some(chunk => chunk.type === 'error'), false, JSON.stringify(chunks));
      assert.equal(entry.effort(body), effort ?? 'low');
      assert.equal(params.reasoningEffort, effort ? 'low' : undefined, 'Does not mutate caller preferences');
    });
  }
}

test('a request effort remains selectable without a saved endpoint override', async t => {
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return response('openai'); });
  const provider = createProvider('openai', 'fixture-only');
  for await (const _ of provider.generateStream({ model: 'openai/gpt-5.1', messages: [{ role: 'user', content: 'Hi' }], stream: false, reasoningEffort: 'medium' })) {}
  assert.equal(body.reasoning_effort, 'medium');
});

test('direct custom connection tests use the saved effort and keep summary thinking disabled', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return response('custom');
  });
  const provider = new CustomProvider('fixture-only', 'https://api.deepseek.com/v1', { reasoningEffort: 'high' });
  assert.equal((await provider.sendTestMessage('deepseek-v4')).ok, true);
  assert.equal(bodies[0].reasoning_effort, 'high');
  for await (const _ of provider.generateStream({ model: 'custom/deepseek-v4', messages: [{ role: 'user', content: 'Summarize' }], stream: false, disableReasoning: true })) {}
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in bodies[1], false);
});

test('classic OpenAI models do not receive a reasoning-only parameter', async t => {
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return response('openai'); });
  for await (const _ of createProvider('openai', 'fixture-only').generateStream({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: false })) {}
  assert.equal('reasoning_effort' in body, false);
});

for (const providerName of ['custom', 'openai'] as const) {
  test(`${providerName} streaming uses the saved effort`, async t => {
    let body: any;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const chunks = [];
    const provider = createByokProvider(providerName, 'fixture-only', 'https://compatible.example/v1', { reasoningEffort: 'medium' });
    for await (const chunk of provider.generateStream({ model: providerName === 'openai' ? 'openai/gpt-5.1' : 'custom/qwen3.8', messages: [{ role: 'user', content: 'Hi' }], reasoningEffort: 'low' })) chunks.push(chunk);
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(chunks.some(chunk => chunk.type === 'error'), false);
    assert.equal(chunks.at(-1)?.type, 'done');
  });
}

test('custom endpoints that reject the effort field retain the existing compatibility retry', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? Response.json({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }, { status: 400 }) : response('custom');
  });
  const chunks = [];
  for await (const chunk of createProvider('custom', 'fixture-only', 'https://compatible.example/v1').generateStream({ model: 'custom/classic-model', messages: [{ role: 'user', content: 'Hi' }], stream: false })) chunks.push(chunk);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal('reasoning_effort' in bodies[1], false);
  assert.equal(chunks.at(-1)?.type, 'done');
});
