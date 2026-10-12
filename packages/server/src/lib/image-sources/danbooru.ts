import { z } from 'zod';

export const DANBOORU_ORIGIN = 'https://danbooru.donmai.us';
export const DANBOORU_MAX_BYTES = 20 * 1024 * 1024;
export class DanbooruError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 413 | 429 | 502 | 503 = 400) { super(message); }
}
export type DanbooruCredentials = { enabled: boolean; username: string; apiKey: string | null };
export type DanbooruPublicConfig = { enabled: boolean; username: string; hasKey: boolean; configured: boolean };
export const danbooruSettingsInput = z.object({
  enabled: z.boolean(), username: z.string().trim().max(100).regex(/^[^:\r\n\x00]*$/),
  apiKey: z.string().trim().max(512).regex(/^[^\r\n\x00]*$/).optional(), clearKey: z.boolean().optional(),
}).strict();
export type DanbooruSettingsInput = z.infer<typeof danbooruSettingsInput>;
export interface DanbooruRepository {
  get(userId: string): Promise<DanbooruCredentials>;
  update(userId: string, input: DanbooruSettingsInput): Promise<DanbooruCredentials>;
  clear(userId: string): Promise<void>;
}
export const defaultDanbooruConfig = (): DanbooruCredentials => ({ enabled: false, username: '', apiKey: null });
export function publicDanbooruConfig(config: DanbooruCredentials): DanbooruPublicConfig {
  return { enabled: config.enabled, username: config.username, hasKey: !!config.apiKey,
    configured: config.enabled && (Boolean(config.username) === Boolean(config.apiKey)) };
}
export function mergeDanbooruSettings(current: DanbooruCredentials, input: DanbooruSettingsInput): DanbooruCredentials {
  const next = { enabled: input.enabled, username: input.username,
    apiKey: input.clearKey ? null : input.apiKey || current.apiKey };
  if (Boolean(next.username) !== Boolean(next.apiKey)) {
    throw new DanbooruError('CREDENTIAL_PAIR_REQUIRED', 'Provide both a Danbooru username and API key, or leave both blank for anonymous access.');
  }
  if (next.apiKey && next.username !== current.username && !input.apiKey && !input.clearKey) {
    throw new DanbooruError('NEW_KEY_REQUIRED', 'Enter the matching API key when changing the Danbooru username.');
  }
  return next;
}
export type DanbooruPost = {
  postId: number; pageUrl: string; sourceUrl: string | null; tags: string; artistTags: string;
  rating: 'g' | 's' | 'q' | 'e'; width: number; height: number; imageUrl: string;
  previewUrl: string | null; fileExt: string; attribution: string;
};
const supportedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
/** Exact official CDN only. Never follow redirects or forward Basic auth to image hosts. */
export function safeDanbooruImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.donmai.us' || url.port || url.username || url.password || url.hash || url.search ||
      !/^\/(?:original|sample|preview)\/[a-zA-Z0-9/_.-]+\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
function publicSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function normalizeDanbooruPost(value: unknown): DanbooruPost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const imageUrl = safeDanbooruImageUrl(p.file_url);
  if (!Number.isSafeInteger(p.id) || Number(p.id) < 1 || p.is_deleted || p.is_banned || !imageUrl ||
    !supportedExtensions.has(String(p.file_ext)) || !['g', 's', 'q', 'e'].includes(String(p.rating)) ||
    !Number.isSafeInteger(p.image_width) || !Number.isSafeInteger(p.image_height) || Number(p.image_width) < 1 || Number(p.image_height) < 1 ||
    Number(p.image_width) * Number(p.image_height) > 40_000_000) return null;
  const pageUrl = `${DANBOORU_ORIGIN}/posts/${p.id}`;
  const artistTags = typeof p.tag_string_artist === 'string' ? p.tag_string_artist.slice(0, 2000) : '';
  return { postId: Number(p.id), pageUrl, sourceUrl: publicSourceUrl(p.source),
    tags: typeof p.tag_string === 'string' ? p.tag_string.slice(0, 16000) : '', artistTags,
    rating: p.rating as DanbooruPost['rating'], width: Number(p.image_width), height: Number(p.image_height),
    imageUrl, previewUrl: safeDanbooruImageUrl(p.preview_file_url), fileExt: String(p.file_ext),
    attribution: `${artistTags ? `Artist tags: ${artistTags}. ` : ''}Danbooru post ${p.id}: ${pageUrl}` };
}
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new DanbooruError('FILE_TOO_LARGE', 'The Danbooru response exceeds the size limit.', 413);
  }
  if (!response.body) throw new DanbooruError('EMPTY_RESPONSE', 'Danbooru returned an empty response.', 502);
  const reader = response.body.getReader();
  let total = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) throw new DanbooruError('FILE_TOO_LARGE', 'The Danbooru response exceeds the size limit.', 413);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, total);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createDanbooruClient(fetcher: typeof fetch = fetch) {
  const request = async (url: string, credentials: DanbooruCredentials, image = false, signal?: AbortSignal) => {
    const headers: Record<string, string> = { 'User-Agent': `Yumina/1.0 (Danbooru image source${credentials.username ? `; account: ${encodeURIComponent(credentials.username)}` : ''})`, Accept: image ? 'image/*' : 'application/json' };
    if (!image && credentials.username && credentials.apiKey) headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.apiKey}`).toString('base64')}`;
    let response: Response;
    try { response = await fetcher(url, { headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }); }
    catch { signal?.throwIfAborted(); throw new DanbooruError('UPSTREAM_UNAVAILABLE', 'Could not reach Danbooru. Try again later.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new DanbooruError('AUTH_FAILED', 'Danbooru denied access. Check your saved credentials and account permissions.', 403);
      if (response.status === 429) throw new DanbooruError('RATE_LIMITED', 'Danbooru is rate limiting requests. Try again later.', 429);
      if (response.status === 404) throw new DanbooruError('POST_NOT_FOUND', 'The Danbooru post was not found.', 404);
      throw new DanbooruError('UPSTREAM_ERROR', 'Danbooru could not complete the request.', 502);
    }
    return response;
  };
  const json = async (path: string, credentials: DanbooruCredentials, signal?: AbortSignal) => {
    try { return JSON.parse((await readBoundedResponse(await request(DANBOORU_ORIGIN + path, credentials, false, signal), 1024 * 1024)).toString('utf8')) as unknown; }
    catch (error) { if (error instanceof DanbooruError) throw error; throw new DanbooruError('INVALID_RESPONSE', 'Danbooru returned an invalid response.', 502); }
  };
  return {
    async test(credentials: DanbooruCredentials): Promise<void> {
      await json(credentials.apiKey ? '/profile.json' : '/posts.json?limit=1', credentials);
    },
    async search(credentials: DanbooruCredentials, input: unknown): Promise<DanbooruPost[]> {
      const query = z.object({ tags: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(20).default(10), page: z.number().int().min(1).max(1000).default(1) }).strict().parse(input);
      const tags = /(?:^|\s)rating:/i.test(query.tags) ? query.tags : `${query.tags} rating:general`;
      const params = new URLSearchParams({ tags, limit: String(query.limit), page: String(query.page) });
      const results = await json(`/posts.json?${params}`, credentials);
      if (!Array.isArray(results)) throw new DanbooruError('INVALID_RESPONSE', 'Danbooru returned an invalid search response.', 502);
      return results.slice(0, query.limit).map(normalizeDanbooruPost).filter((p): p is DanbooruPost => !!p);
    },
    async download(credentials: DanbooruCredentials, postId: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(postId) || postId < 1) throw new DanbooruError('INVALID_POST_ID', 'Choose a positive integer Danbooru post ID.');
      const post = normalizeDanbooruPost(await json(`/posts/${postId}.json`, credentials, signal));
      if (!post || post.postId !== postId) throw new DanbooruError('UNSUPPORTED_POST', 'This Danbooru post has no supported downloadable image.');
      const response = await request(post.imageUrl, credentials, true, signal);
      if (!/^image\/(?:jpeg|png|webp|gif|avif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw new DanbooruError('UNSUPPORTED_IMAGE', 'Danbooru did not return a supported raster image.');
      }
      return { post, bytes: await readBoundedResponse(response, DANBOORU_MAX_BYTES) };
    },
  };
}
export type DanbooruImportedAsset = { id: string; ref: string; filename: string; source: DanbooruPost };
export function createDanbooruService(repository: DanbooruRepository,
  store: (userId: string, bytes: Buffer, source: DanbooruPost, filename?: string, signal?: AbortSignal) => Promise<DanbooruImportedAsset>, client = createDanbooruClient()) {
  const requireConfig = async (userId: string) => {
    const config = await repository.get(userId);
    if (!publicDanbooruConfig(config).configured) throw new DanbooruError('SOURCE_DISABLED', 'Enable Danbooru in Settings → AI Configuration → Danbooru artwork search before using it.', 403);
    return config;
  };
  return {
    async getConfig(userId: string) { return publicDanbooruConfig(await repository.get(userId)); },
    async updateConfig(userId: string, input: unknown) { return publicDanbooruConfig(await repository.update(userId, danbooruSettingsInput.parse(input))); },
    async clearConfig(userId: string) { await repository.clear(userId); return publicDanbooruConfig(defaultDanbooruConfig()); },
    async test(userId: string) { await client.test(await requireConfig(userId)); return { ok: true, message: 'Danbooru connection succeeded.' }; },
    async search(userId: string, input: unknown) { return client.search(await requireConfig(userId), input); },
    async import(userId: string, postId: number, filename?: string, signal?: AbortSignal) {
      if (filename !== undefined) z.string().trim().min(1).max(150).regex(/^[^\x00-\x1f/\\]+$/).parse(filename);
      const { post, bytes } = await client.download(await requireConfig(userId), postId, signal); signal?.throwIfAborted(); return store(userId, bytes, post, filename, signal);
    },
  };
}
