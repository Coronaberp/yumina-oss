import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { GenerationError } from './config.js';
import { allowedEndpointAddress, allowedEndpointHostname, type EndpointPolicy } from './endpoint-policy.js';
export type ProviderResponse = Readable & { statusCode?: number; statusMessage?: string; headers: IncomingHttpHeaders };
export type ProviderRequest = { on(event: 'error', listener: (error: Error) => void): unknown; end(body?: string | Uint8Array): unknown; destroy(error?: Error): unknown };
export type ProviderNetwork = {
  resolve(hostname: string): Promise<LookupAddress[]>;
  request(url: URL, options: RequestOptions, receive: (response: ProviderResponse) => void): ProviderRequest;
};
const productionNetwork: ProviderNetwork = {
  resolve: hostname => dnsLookup(hostname, { all: true, verbatim: true }),
  request: (url, options, receive) => (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, receive),
};
const MAX_MULTIPART_BYTES = 20 * 1024 * 1024 + 64 * 1024;

async function encodeMultipartFormData(form: FormData, signal: AbortSignal) {
  const boundary = `----IllumiFormBoundary${randomUUID().replaceAll('-', '')}`;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const append = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_MULTIPART_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The multipart image upload exceeds the size limit.', 413);
    chunks.push(bytes);
  };
  const parameter = (value: string, label: string) => {
    if (!value || value.length > 180 || !/^[a-zA-Z0-9._ -]+$/.test(value))
      throw new GenerationError('INVALID_REQUEST', `The multipart ${label} is invalid.`);
    return value;
  };
  for (const [name, value] of form.entries()) {
    signal.throwIfAborted();
    const safeName = parameter(name, 'field name');
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"`);
    if (typeof value === 'string') {
      append(`\r\n\r\n${value}\r\n`);
      continue;
    }
    if (!(value instanceof Blob)) throw new GenerationError('INVALID_REQUEST', 'The multipart image upload contains an unsupported part.');
    const filename = parameter(value instanceof File ? value.name : 'blob', 'filename');
    const contentType = value.type || 'application/octet-stream';
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType))
      throw new GenerationError('INVALID_REQUEST', 'The multipart image content type is invalid.');
    append(`; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
    append(new Uint8Array(await value.arrayBuffer()));
    append('\r\n');
  }
  append(`--${boundary}--\r\n`);
  return { bytes: Buffer.concat(chunks, totalBytes), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}
export async function resolveProviderAddresses(hostname: string, policy: EndpointPolicy, signal: AbortSignal, network: Pick<ProviderNetwork, 'resolve'> = productionNetwork): Promise<LookupAddress[]> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!allowedEndpointHostname(host, policy)) throw new GenerationError('UNSAFE_ENDPOINT', 'The configured image endpoint is not allowed in this installation.');
  const literal = isIP(host);
  let addresses: LookupAddress[];
  try { addresses = literal ? [{ address: host, family: literal }] : await abortable(network.resolve(host), signal); }
  catch { signal.throwIfAborted(); throw new GenerationError('ENDPOINT_UNAVAILABLE', 'The image endpoint could not be resolved.', 503); }
  signal.throwIfAborted();
  // Reject the entire result set. Never allow Node to pick an unchecked fallback address.
  if (!addresses.length || addresses.length > 100 || addresses.some(item => isIP(item.address) !== item.family || !allowedEndpointAddress(item.address, policy)))
    throw new GenerationError('UNSAFE_ENDPOINT', 'The configured image endpoint resolved to a forbidden address.');
  return addresses;
}
export function pinnedProviderLookup(addresses: readonly LookupAddress[], expectedHostname: string): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase().replace(/\.$/, '') !== expectedHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')) {
      callback(Object.assign(new Error('Unexpected provider hostname'), { code: 'EACCES' }), ''); return;
    }
    const candidates = addresses.filter(item => !options.family || item.family === options.family);
    if (!candidates.length) { callback(Object.assign(new Error('No vetted address in requested family'), { code: 'ENOTFOUND' }), ''); return; }
    if (options.all) callback(null, candidates.map(item => ({ ...item })));
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}
/** Native requester uses the vetted lookup only, fresh sockets, original TLS hostname, and no proxy/redirect routing. */
export function createPinnedProviderFetch(policy: EndpointPolicy, network: ProviderNetwork = productionNetwork): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new GenerationError('UNSAFE_ENDPOINT', 'The image endpoint URL is not allowed.');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? AbortSignal.timeout(180_000);
    const addresses = await resolveProviderAddresses(url.hostname, policy, signal, network);
    const headers = new Headers(init?.headers);
    headers.set('Host', url.host); headers.set('Accept-Encoding', 'identity');
    let body: string | Uint8Array | undefined;
    if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
      const multipart = await encodeMultipartFormData(init.body, signal);
      body = multipart.bytes;
      headers.set('Content-Type', multipart.contentType);
    } else if (typeof init?.body === 'string' || init?.body instanceof Uint8Array) body = init.body;
    else if (init?.body != null) throw new GenerationError('INVALID_REQUEST', 'Unsupported image provider request body.');
    if (body != null) headers.set('Content-Length', String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength));
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      let pending: ProviderRequest | undefined; let incoming: ProviderResponse | undefined; let settled = false;
      const cleanup = () => signal.removeEventListener('abort', abort);
      const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
      const abort = () => {
        const error = signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        pending?.destroy(error); incoming?.destroy(error); fail(error);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        pending = network.request(url, { method: init?.method ?? 'GET', headers: Object.fromEntries(headers.entries()),
          agent: false, lookup: pinnedProviderLookup(addresses, url.hostname), signal,
          ...(url.protocol === 'https:' ? { servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname } : {}),
        } as RequestOptions, response => {
          incoming = response;
          if (settled || signal.aborted) { response.destroy(); if (signal.aborted) abort(); return; }
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy(); fail(new GenerationError('REDIRECT_DENIED', 'Image provider redirects are not allowed.', 503)); return;
          }
          response.once('close', cleanup);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          try {
            const stream = [204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
            settled = true;
            resolve(new Response(stream, { status, headers: responseHeaders }));
          } catch (error) { response.destroy(); settled = false; fail(error instanceof Error ? error : new Error('Invalid provider response')); }
        });
        pending.on('error', fail);
        if (signal.aborted) abort(); else pending.end(body ?? undefined);
      } catch (error) { pending?.destroy(); fail(error instanceof Error ? error : new Error('Provider request failed')); }
    });
  };
}
