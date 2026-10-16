import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { CustomProvider } from './custom.js';
import type { GenerateParams, StreamChunk } from './types.js';

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const noisyPng = sharp(randomBytes(1536 * 1536 * 3), { raw: { width: 1536, height: 1536, channels: 3 } }).png().toBuffer();
async function collect(provider: CustomProvider, params: GenerateParams) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.generateStream(params)) chunks.push(chunk);
  return chunks;
}

for (const stream of [true, false]) {
  test(`custom ${stream ? 'streaming' : 'non-streaming'} image requests fit the endpoint byte limit before the first request`, async t => {
    const bytes = await noisyPng;
    const image = `data:image/png;base64,${bytes.toString('base64')}`;
    const params: GenerateParams = {
      model: 'custom/vision', stream, singleAttempt: true, temperature: 0.8, topP: 0.95, topK: 40,
      maxTokens: 1200, conversationId: 'studio:test-owner:test-world:test-chat',
      messages: [
        { role: 'system', content: 'Keep all instructions.' },
        { role: 'user', content: [{ type: 'text', text: 'Use both references.' }, { type: 'image_url', image_url: { url: image } }] },
        { role: 'assistant', content: 'Previous answer.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: 'Keep this text after the image.' }] },
      ],
      tools: [{ type: 'function', function: { name: 'read_world', description: 'Read the current world.', parameters: { type: 'object' } } }],
      toolChoice: 'auto',
    };
    const original = JSON.stringify(params);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const request = String(init.body); requests.push(request);
      if (Buffer.byteLength(request) > 4.5 * 1024 * 1024) return new Response('Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE', { status: 413 });
      return stream ? new Response('data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] });
    });
    const chunks = await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), params);
    assert.equal(chunks.some(chunk => chunk.type === 'error'), false, JSON.stringify(chunks));
    assert.equal(requests.length, 1);
    assert.ok(Buffer.byteLength(requests[0]!) <= MAX_REQUEST_BYTES);
    const body = JSON.parse(requests[0]!);
    assert.equal(body.messages.length, 4);
    assert.equal(body.messages[0].content, 'Keep all instructions.');
    assert.equal(body.messages[1].content[0].text, 'Use both references.');
    assert.equal(body.messages[2].content, 'Previous answer.');
    assert.equal(body.messages[3].content[1].text, 'Keep this text after the image.');
    assert.equal(body.messages[1].content[1].image_url.url, body.messages[3].content[0].image_url.url);
    const url = body.messages[1].content[1].image_url.url;
    assert.notEqual(url, image);
    const metadata = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.width, 1536, 'Opaque references retain useful detail when re-encoding is enough');
    assert.equal(metadata.height, 1536);
    assert.deepEqual(body.tools, params.tools);
    assert.equal(body.max_tokens, 1200);
    assert.equal(body.temperature, 0.8);
    assert.equal(body.top_p, 0.95);
    assert.equal(body.top_k, 40);
    assert.equal(JSON.stringify(params), original, 'Original references and caller preferences remain unchanged');
    assert.equal(chunks.at(-1)?.type, 'done');
  });
}

test('small image requests retain their original bytes', async t => {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
  const image = `data:image/png;base64,${bytes.toString('base64')}`;
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }); });
  await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), { model: 'custom/vision', stream: false,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }] });
  assert.equal(body.messages[0].content[0].image_url.url, image);
});

test('oversized transparent references keep alpha and every image', async t => {
  const pixels = randomBytes(1024 * 1024 * 4);
  const bytes = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
  const image = `data:image/png;base64,${bytes.toString('base64')}`;
  let body: any, requestBytes = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requestBytes = Buffer.byteLength(String(init.body)); body = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] });
  });
  const chunks = await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), { model: 'custom/vision', stream: false,
    messages: [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image_url' as const, image_url: { url: image } })) }] });
  assert.equal(chunks.some(chunk => chunk.type === 'error'), false);
  assert.ok(requestBytes <= MAX_REQUEST_BYTES);
  assert.equal(body.messages[0].content.length, 5);
  const metadata = await sharp(Buffer.from(body.messages[0].content[0].image_url.url.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.hasAlpha, true);
});

test('image preparation reports oversized text without dropping instructions or making an upstream request', async t => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'gold' } }).png().toBuffer();
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (...args: unknown[]) => { requests.push(args); return Response.json({}); });
  const params: GenerateParams = { model: 'custom/vision', stream: false, messages: [
    { role: 'system', content: 'x'.repeat(MAX_REQUEST_BYTES) },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] },
  ] };
  const original = JSON.stringify(params);
  const chunks = await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), params);
  assert.equal(requests.length, 0);
  assert.ok(chunks.some(chunk => chunk.type === 'error' && /too much text or tool data/.test(chunk.content)));
  assert.equal(JSON.stringify(params), original);
});

test('cancelled oversized image preparation never sends a request', async t => {
  const bytes = await noisyPng;
  const controller = new AbortController(); controller.abort();
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (...args: unknown[]) => { requests.push(args); return Response.json({}); });
  const chunks = await collect(new CustomProvider('fixture-only', 'https://compatible.example/v1'), { model: 'custom/vision', signal: controller.signal,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }] });
  assert.equal(requests.length, 0);
  assert.equal(chunks.length, 0);
});
