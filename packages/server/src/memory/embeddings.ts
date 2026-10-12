import type { EmbeddingClient, EmbeddingProfile } from './types.js';

export const DEFAULT_EMBEDDING_MODEL = 'Qwen3-Embedding-0.6B';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
export const QUERY_INSTRUCTION = 'Given the current roleplay moment, retrieve character facts, relationships, unresolved commitments, and world details needed to stay consistent.';
export class EmbeddingError extends Error {
  constructor(public readonly code: 'configuration' | 'invalid_vector' | 'http' | 'response' | 'network' | 'timeout' | 'cancelled') {
    super(code === 'timeout' ? 'Memory embedding request timed out' : code === 'cancelled' ? 'Memory embedding request cancelled' : `Memory embedding ${code} error`);
    this.name = 'EmbeddingError';
  }
}
export type EmbeddingTransportProfile = Pick<EmbeddingProfile, 'baseUrl'> & Partial<Pick<EmbeddingProfile, 'model' | 'dimensions' | 'sendDimensions'>>;
export interface EmbeddingTransportOptions {
  fetch?: typeof fetch;
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}
export function normalizeEmbeddingBase(base: string): string {
  if (typeof base !== 'string' || !base.trim()) throw new EmbeddingError('configuration');
  let normalized = base.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/embeddings')) normalized = normalized.slice(0, -11);
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new EmbeddingError('configuration'); }
  return normalized.endsWith('/v1') ? normalized : normalized + '/v1';
}
function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) throw new EmbeddingError('configuration');
}
/** pgvector stores float32: reject values that become infinite or a zero vector. */
export function validateEmbeddingVector(vector: unknown, dimensions: number): number[] {
  validateDimensions(dimensions);
  if (!Array.isArray(vector) || vector.length !== dimensions) throw new EmbeddingError('invalid_vector');
  const result: number[] = [];
  let nonzero = false;
  for (let i = 0; i < vector.length; i++) {
    const n: unknown = vector[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new EmbeddingError('invalid_vector');
    const rounded = Math.fround(n);
    if (!Number.isFinite(rounded)) throw new EmbeddingError('invalid_vector');
    if (rounded !== 0) nonzero = true;
    result.push(rounded);
  }
  if (!nonzero) throw new EmbeddingError('invalid_vector');
  return result;
}
export function createEmbeddingClient(profile: EmbeddingTransportProfile, apiKey: string, options: EmbeddingTransportOptions = {}): EmbeddingClient {
  const url = normalizeEmbeddingBase(profile.baseUrl) + '/embeddings';
  const model = (profile.model ?? DEFAULT_EMBEDDING_MODEL).trim();
  const dimensions = profile.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const sendDimensions = profile.sendDimensions === true;
  validateDimensions(dimensions);
  if (!model || typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new EmbeddingError('configuration');
  const fetcher = options.fetch ?? fetch, schedule = options.setTimeout ?? setTimeout, cancelTimer = options.clearTimeout ?? clearTimeout;
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (signal?.aborted) throw new EmbeddingError('cancelled');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      const stop = (code: 'timeout' | 'cancelled') => { reject(new EmbeddingError(code)); controller.abort(); };
      abortListener = () => stop('cancelled');
      signal?.addEventListener('abort', abortListener, { once: true });
      timer = schedule(() => stop('timeout'), 60000);
    });
    try {
      const operation = (async () => {
        const response = await fetcher(url, {
          method: 'POST', headers: { ...headers }, signal: controller.signal,
          body: JSON.stringify({ model, input: text, ...(sendDimensions ? { dimensions } : {}) }),
        });
        if (!response.ok) throw new EmbeddingError('http');
        let payload: any;
        try { payload = await response.json(); } catch { throw new EmbeddingError('response'); }
        return validateEmbeddingVector(payload?.data?.[0]?.embedding, dimensions);
      })();
      return await Promise.race([operation, stopped]);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError('network');
    } finally {
      if (timer !== undefined) cancelTimer(timer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
  }
  return { embed, embedQuery: (text, signal) => embed(`Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}`, signal) };
}
