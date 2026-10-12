import { IS_LOCAL_EDITION } from '../env.js';
import { createPinnedProviderFetch } from './host-transport.js';
import { setTimeout as delay } from 'node:timers/promises';
import { GenerationError, record, type Profile } from './config.js';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export type ProviderDependencies = { fetch?: typeof fetch; pollDelayMs?: number; timeoutMs?: number };
export type ProviderRequestOptions = { authorization?: 'bearer' | 'basic'; allowPrivate?: boolean };
export function combinedSignal(signal?: AbortSignal, timeoutMs = 180_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function providerUrl(profile: Profile, path: string): URL {
  const base = new URL(profile.baseUrl + '/');
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new GenerationError('INVALID_URL', 'Provider request escaped the configured endpoint.');
  return url;
}
export async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const announced = Number(response.headers.get('content-length'));
  if (announced > maximum) throw new GenerationError('FILE_TOO_LARGE', 'The provider response exceeds the image size limit.', 413);
  if (!response.body) throw new GenerationError('INVALID_RESPONSE', 'The provider returned an empty response.', 503);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new GenerationError('FILE_TOO_LARGE', 'The provider response exceeds the image size limit.', 413);
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
export async function request(profile: Profile, url: URL, signal: AbortSignal, fetcher: typeof fetch, body?: unknown, options: ProviderRequestOptions = {}): Promise<Response> {
  signal.throwIfAborted();
  // ComfyUI and Forge Neo may be local in the local edition; settings reject private hosts elsewhere.
  // Explicit injected fetch is for focused mocks. Production always uses vetted, pinned sockets.
  const outbound = fetcher === globalThis.fetch ? createPinnedProviderFetch({ allowPrivate: IS_LOCAL_EDITION && (!!profile.workflow || options.allowPrivate === true) }) : fetcher;
  let authorization: string | undefined;
  if (profile.apiKey) {
    if (options.authorization === 'basic') {
      const separator = profile.apiKey.indexOf(':');
      if (separator < 1) throw new GenerationError('INVALID_KEY', 'Forge Neo authentication must use username:password.');
      authorization = `Basic ${Buffer.from(profile.apiKey).toString('base64')}`;
    } else authorization = `Bearer ${profile.apiKey}`;
  }
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await outbound(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: (multipart ? body : JSON.stringify(body)) as NonNullable<Parameters<typeof fetch>[1]>["body"] }) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new GenerationError('AUTH_FAILED', 'The provider rejected the saved credentials.', 503);
    if (response.status === 429) throw new GenerationError('RATE_LIMITED', 'The provider is rate limited. Try again later.', 429);
    throw new GenerationError('PROVIDER_FAILED', 'The provider rejected the request. Check its configuration and API availability.', 503);
  }
  return response;
}
export async function requestJson(profile: Profile, path: string, signal: AbortSignal, fetcher: typeof fetch, body?: unknown, maximum = 4 * 1024 * 1024, options: ProviderRequestOptions = {}) {
  const bytes = await readBounded(await request(profile, providerUrl(profile, path), signal, fetcher, body, options), maximum, signal);
  try { const value: unknown = JSON.parse(bytes.toString('utf8')); if (!record(value)) throw new Error(); return value; }
  catch { throw new GenerationError('INVALID_RESPONSE', 'The provider returned invalid JSON.', 503); }
}
export async function pollDelay(milliseconds: number, signal: AbortSignal) { await delay(milliseconds, undefined, { signal }); }
export function safeGenerationFailure(error: unknown, signal?: AbortSignal): GenerationError {
  if (signal?.aborted) return new GenerationError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
    signal.reason?.name === 'TimeoutError' ? 'Image generation timed out. Check the provider queue before trying again.' : 'Image generation was stopped.', 503);
  return error instanceof GenerationError ? error : new GenerationError('PROVIDER_UNAVAILABLE', 'The image provider could not be reached. Check Settings → AI Configuration.', 503);
}
