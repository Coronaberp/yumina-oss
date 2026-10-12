import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:http';
import { allowedEndpointAddress, allowedEndpointHostname } from './endpoint-policy.js';
import { createPinnedProviderFetch, resolveProviderAddresses, pinnedProviderLookup, type ProviderNetwork, type ProviderResponse } from './host-transport.js';
import { GenerationError, normalizeGenerationUrl } from './config.js';
import { readBounded } from './transport.js';
const publicPolicy = { allowPrivate: false }; const localPolicy = { allowPrivate: true };
const publicAddress = { address: '93.184.216.34', family: 4 };
function response(status = 200, headers: Record<string,string> = {}, bytes = 'image'): ProviderResponse {
  return Object.assign(Readable.from([Buffer.from(bytes)]), { statusCode: status, headers });
}
function mockNetwork(addresses: LookupAddress[], receive: () => ProviderResponse = () => response()) {
  const calls: { url: URL; options: RequestOptions; body?: string | Uint8Array }[] = [];
  let resolutions = 0; let destroyed = 0;
  const network: ProviderNetwork = {
    resolve: async () => { resolutions++; return addresses; },
    request(url, options, callback) {
      const call: typeof calls[number] = { url, options }; calls.push(call);
      const events = new EventEmitter();
      return { on: (event, listener) => events.on(event, listener),
        end(body) { call.body = body; queueMicrotask(() => callback(receive())); },
        destroy(error) { destroyed++; if (error) queueMicrotask(() => events.emit('error', error)); },
      };
    },
  };
  return { network, calls, get resolutions() { return resolutions; }, get destroyed() { return destroyed; } };
}
test('local ComfyUI and Forge Neo allow private hosts; hosted profiles require public endpoints', () => {
  for (const url of ['http://127.0.0.1:8188', 'http://[::1]:8188', 'http://192.168.1.10:8188', 'http://comfyui:8188']) {
    assert.equal(normalizeGenerationUrl(url, 'comfyui', true), url);
    assert.throws(() => normalizeGenerationUrl(url, 'comfyui', false), GenerationError);
    assert.throws(() => normalizeGenerationUrl(url.replace('http:', 'https:'), 'forgeneo', false), GenerationError);
  }
  assert.equal(normalizeGenerationUrl('https://comfy.example.com/proxy/', 'comfyui', false), 'https://comfy.example.com/proxy');
});
test('metadata/link-local/mapped/tunnel/unspecified destinations remain forbidden even locally', () => {
  for (const ip of ['169.254.169.254', '169.254.1.1', '168.63.129.16', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    'fd00:ec2::254', 'fd00:0ec2:0000:0000:0000:0000:0000:0254', 'fe80::1', 'febf::1', '::', 'ff02::1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::127.0.0.1', '2002:7f00:1::1', '2001:0::1']) {
    assert.equal(allowedEndpointAddress(ip, localPolicy), false, ip);
    assert.equal(allowedEndpointAddress(ip, publicPolicy), false, ip);
  }
  for (const host of ['metadata', 'metadata.', 'metadata.google.internal', 'metadata.google.internal.']) assert.equal(allowedEndpointHostname(host, localPolicy), false, host);
});
test('public policy covers IPv4 private/shared/reserved and IPv6 private/documentation', () => {
  for (const ip of ['10.1.2.3','127.0.0.2','172.31.1.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','fc00::1','fd12::1','fec0::1','2001:db8::1'])
    assert.equal(allowedEndpointAddress(ip, publicPolicy), false, ip);
  for (const ip of ['93.184.216.34','8.8.8.8','192.0.73.2','2001:4860:4860::8888','2606:4700:4700::1111']) assert.equal(allowedEndpointAddress(ip, publicPolicy), true, ip);
  for (const ip of ['127.0.0.1','10.1.2.3','172.20.1.1','192.168.1.1','100.100.1.1','::1','fd12::1']) assert.equal(allowedEndpointAddress(ip, localPolicy), true, ip);
});
test('DNS private answer and mixed answer sets are rejected before opening any socket', async () => {
  for (const addresses of [[{address:'127.0.0.1',family:4}], [publicAddress,{address:'169.254.169.254',family:4}], [publicAddress,{address:'fd00:ec2::254',family:6}]]) {
    const mocked = mockNetwork(addresses);
    await assert.rejects(createPinnedProviderFetch(publicPolicy, mocked.network)('https://comfy.example.com/system_stats'), (error: unknown) => error instanceof GenerationError && error.code === 'UNSAFE_ENDPOINT');
    assert.equal(mocked.calls.length, 0);
  }
});
test('local DNS may resolve private Comfy hosts, but never metadata or link-local answers', async () => {
  const local = mockNetwork([{address:'192.168.1.10',family:4}]);
  assert.equal((await createPinnedProviderFetch(localPolicy, local.network)('http://comfy.lan:8188/view')).status, 200);
  for (const address of ['169.254.169.254','fe80::1','fd00:ec2::254']) {
    const mocked = mockNetwork([{address,family:address.includes(':')?6:4}]);
    await assert.rejects(createPinnedProviderFetch(localPolicy, mocked.network)('http://comfy.lan:8188/system_stats'), GenerationError);
    assert.equal(mocked.calls.length, 0);
  }
});
test('lookup pins vetted IPs without another DNS query and preserves original TLS host', async () => {
  const mocked = mockNetwork([publicAddress,{address:'2606:4700:4700::1111',family:6}]);
  const fetched = await createPinnedProviderFetch(publicPolicy, mocked.network)('https://comfy.example.com/view', { headers: { Authorization:'Bearer test-key' }, signal: AbortSignal.timeout(1000) });
  assert.equal(await fetched.text(), 'image'); assert.equal(mocked.resolutions, 1);
  const options = mocked.calls[0]!.options;
  assert.equal(options.agent, false); assert.equal((options as RequestOptions & {servername:string}).servername, 'comfy.example.com');
  const headers = options.headers as Record<string,string>; assert.equal(headers.host, 'comfy.example.com'); assert.equal(headers.authorization, 'Bearer test-key');
  const lookup = options.lookup!;
  lookup('comfy.example.com', {all:true}, (error, result) => { assert.equal(error,null); assert.deepEqual(result,[publicAddress,{address:'2606:4700:4700::1111',family:6}]); });
  lookup('comfy.example.com', {family:4}, (error, address, family) => { assert.equal(error,null); assert.equal(address,publicAddress.address); assert.equal(family,4); });
  // This second lookup is still the vetted snapshot, even if attacker-controlled DNS would now return private IPs.
  lookup('comfy.example.com', {}, (error, address) => { assert.equal(error,null); assert.equal(address,publicAddress.address); });
  assert.equal(mocked.resolutions, 1);
});
test('pinned lookup rejects hostname changes and missing address families', () => {
  const lookup = pinnedProviderLookup([publicAddress], 'comfy.example.com');
  lookup('metadata.google.internal', {}, error => assert.equal(error?.code,'EACCES'));
  lookup('comfy.example.com', {family:6}, error => assert.equal(error?.code,'ENOTFOUND'));
});
test('literal IPs are vetted without DNS and redirects are not followed', async () => {
  const mocked = mockNetwork([], () => response(302, {location:'http://169.254.169.254/key'}));
  await assert.rejects(createPinnedProviderFetch(publicPolicy, mocked.network)('https://93.184.216.34/view'), (error: unknown) => error instanceof GenerationError && error.code === 'REDIRECT_DENIED');
  assert.equal(mocked.resolutions, 0); assert.equal(mocked.calls.length, 1);
  assert.equal((mocked.calls[0]!.options as RequestOptions & {servername:string}).servername,'');
});
test('abort during DNS resolution rejects promptly and creates no HTTP request', async () => {
  const controller = new AbortController(); let requests = 0;
  const network: ProviderNetwork = { resolve: () => new Promise(() => {}), request: () => { requests++; throw new Error('Unexpected request'); } };
  const pending = createPinnedProviderFetch(publicPolicy, network)('https://comfy.example.com/prompt',{signal:controller.signal});
  controller.abort(new Error('stopped'));
  await assert.rejects(pending,/stopped/); assert.equal(requests,0);
});
test('abort after headers destroys both request and response and stops bounded image reading', async () => {
  const stream = Object.assign(new Readable({read(){}}), {statusCode:200,headers:{}});
  const mocked = mockNetwork([publicAddress], () => stream);
  const controller = new AbortController();
  const fetched = await createPinnedProviderFetch(publicPolicy,mocked.network)('https://comfy.example.com/view',{signal:controller.signal});
  const pending = readBounded(fetched,20,controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(pending,/stopped/); assert.equal(mocked.destroyed,1); assert.equal(stream.destroyed,true);
});
test('native request keeps approved JSON body and bounded response consumption', async () => {
  const mocked = mockNetwork([publicAddress], () => response(200,{'content-type':'application/json'},'{"prompt_id":"job"}'));
  const fetched = await createPinnedProviderFetch(publicPolicy,mocked.network)('https://comfy.example.com/prompt', {method:'POST',body:'{"prompt":{}}',headers:{'Content-Type':'application/json'}});
  assert.equal(mocked.calls[0]!.body,'{"prompt":{}}');
  assert.equal((mocked.calls[0]!.options.headers as Record<string,string>)['content-length'],'13');
  assert.equal((await readBounded(fetched,100,AbortSignal.timeout(1000))).toString(),'{"prompt_id":"job"}');
});

test('pinned local Comfy uploads bounded multipart references with a matching content length', async () => {
  const mocked = mockNetwork([{address:'192.168.1.10',family:4}]);
  const form = new FormData();
  form.append('type', 'input');
  form.append('overwrite', 'false');
  form.append('image', new Blob([Buffer.from('png-reference-bytes')], { type: 'image/png' }), 'owned-reference.png');
  const fetched = await createPinnedProviderFetch(localPolicy, mocked.network)('http://comfy.lan:8188/upload/image',
    { method: 'POST', body: form, signal: AbortSignal.timeout(1000) });
  assert.equal(fetched.status, 200);
  const call = mocked.calls[0]!;
  const headers = call.options.headers as Record<string, string>;
  assert.match(headers['content-type']!, /^multipart\/form-data; boundary=/);
  const bytes = Buffer.from(call.body!);
  assert.equal(Number(headers['content-length']), bytes.length);
  const body = bytes.toString('latin1');
  assert.match(body, /name="type"\r\n\r\ninput/);
  assert.match(body, /filename="owned-reference\.png"/);
  assert.match(body, /Content-Type: image\/png/);
  assert.ok(bytes.includes(Buffer.from('png-reference-bytes')));
  assert.match(body, /--[^\r\n]+--\r\n$/);
});

test('pinned multipart serializer rejects oversized file payloads before opening a socket', async () => {
  const mocked = mockNetwork([{address:'192.168.1.10',family:4}]);
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(21 * 1024 * 1024)], { type: 'image/png' }), 'too-large.png');
  await assert.rejects(createPinnedProviderFetch(localPolicy, mocked.network)('http://comfy.lan:8188/upload/image',
    { method: 'POST', body: form, signal: AbortSignal.timeout(1000) }),
  (error: unknown) => error instanceof GenerationError && error.code === 'FILE_TOO_LARGE');
  assert.equal(mocked.calls.length, 0);
});

test('URL canonicalization cannot bypass private or metadata policy with decimal/hex/mapped IPv4', () => {
  assert.equal(normalizeGenerationUrl('http://2130706433:8188', 'comfyui', true), 'http://127.0.0.1:8188');
  assert.throws(() => normalizeGenerationUrl('http://2130706433:8188', 'comfyui', false), GenerationError);
  for (const url of ['http://0xa9fea9fe', 'http://2852039166', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:a9fe:a9fe]'])
    assert.throws(() => normalizeGenerationUrl(url, 'comfyui', true), GenerationError);
});
