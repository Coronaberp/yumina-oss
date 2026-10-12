import { IS_LOCAL_EDITION } from '../env.js';
import { GenerationError, record, type ImageKind, type Profile } from './config.js';
import { MAX_IMAGE_BYTES, requestJson } from './transport.js';

const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;

export async function generateForgeNeoImage(profile: Profile, prompt: string, imageKind: ImageKind, signal: AbortSignal, fetcher = fetch) {
  const [width, height] = imageKind === 'background' ? [1536, 1024] : imageKind === 'sprite' ? [1024, 1536] : [1024, 1024];
  const response = await requestJson(profile, 'sdapi/v1/txt2img', signal, fetcher, {
    prompt,
    width,
    height,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
    ...(profile.model ? { override_settings: { sd_model_checkpoint: profile.model } } : {}),
    ...(profile.model ? { override_settings_restore_afterwards: true } : {}),
  }, MAX_RESPONSE_BYTES, { authorization: 'basic', allowPrivate: IS_LOCAL_EDITION });

  const first = Array.isArray(response.images) ? response.images[0] : undefined;
  if (typeof first !== 'string') throw new GenerationError('INVALID_IMAGE', 'Forge Neo returned no generated image.', 503);
  const encoded = first.startsWith('data:image/') ? first.slice(first.indexOf(',') + 1) : first;
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new GenerationError('INVALID_IMAGE', 'Forge Neo must return a base64-encoded image.', 503);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new GenerationError('FILE_TOO_LARGE', 'The generated image must be at most 20 MB.', 413);
  return bytes;
}

export async function testForgeNeoConnection(profile: Profile, signal: AbortSignal, fetcher = fetch) {
  // Read-only check; testing the connection never creates an image.
  const response = await requestJson(profile, 'sdapi/v1/options', signal, fetcher, undefined, 4 * 1024 * 1024,
    { authorization: 'basic', allowPrivate: IS_LOCAL_EDITION });
  if (!Object.hasOwn(response, 'sd_model_checkpoint'))
    throw new GenerationError('INVALID_RESPONSE', 'The endpoint did not return Forge Neo options.', 503);
}
