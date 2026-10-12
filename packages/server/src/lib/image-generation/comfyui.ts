import { randomUUID } from 'node:crypto';
import { ANIMA_BUILTIN_WORKFLOW, GenerationError, record, workflowWithPrompt, type Profile } from './config.js';
import { ANIMA_OUTPUT_NODE_IDS, buildAnimaSpriteWorkflow, DEFAULT_ANIMA_MODEL, filterAnimaLoras, filterAnimaModels,
  type UploadedAnimaReference } from './anima-workflow.js';
import { buildKreaReferenceWorkflow, KREA_MODEL, KREA_OUTPUT_NODE_IDS } from './krea-workflow.js';
import { MAX_IMAGE_BYTES, providerUrl, request, requestJson, readBounded, pollDelay, type ProviderDependencies } from './transport.js';

export type AnimaReferenceUpload = { name: string; role: UploadedAnimaReference['role']; bytes: Buffer; contentType?: string };
export type AnimaRequestOptions = { animaModel?: string; chromaColor: string; seed?: number; steps?: number;
  cfg?: number; imageKind?: 'sprite' | 'background' | 'image'; transparent?: boolean;
  samplerName?: "er_sde" | "euler"; scheduler?: "simple" | "normal" | "sgm_uniform";
  references: AnimaReferenceUpload[]; progress?: (event: { phase: 'preparing' | 'queued' | 'generating' | 'segmenting' | 'processing' | 'saving'; percent?: number }) => void };
export type KreaRequestOptions = { imageKind: 'sprite' | 'background' | 'image'; transparent?: boolean; seed?: number; steps?: number; cfg?: number;
  references: AnimaReferenceUpload[]; progress?: AnimaRequestOptions['progress'] };
export type ComfyImageDependencies = ProviderDependencies & { webSocket?: typeof WebSocket | null };

async function requestValue(profile: Profile, path: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  const bytes = await readBounded(await request(profile, providerUrl(profile, path), signal, fetcher), 2 * 1024 * 1024, signal);
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new GenerationError('INVALID_RESPONSE', 'ComfyUI returned invalid model-list data.', 503); }
}
function namesFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (record(value) && Array.isArray(value.models)) return value.models;
  throw new GenerationError('INVALID_RESPONSE', 'ComfyUI returned an invalid model catalog.', 503);
}

export async function getComfyAnimaModels(profile: Profile, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const [modelResult, loraResult] = await Promise.all([
    requestValue(profile, 'models/diffusion_models', signal, fetcher),
    requestValue(profile, 'models/loras', signal, fetcher),
  ]);
  const models = filterAnimaModels(namesFrom(modelResult));
  const loras = filterAnimaLoras(namesFrom(loraResult));
  if (!models.length) throw new GenerationError('ANIMA_MODELS_NOT_FOUND', 'No Anima checkpoints are installed in the configured ComfyUI container.', 503);
  return { models, loras, recommendedModel: models.includes(DEFAULT_ANIMA_MODEL) ? DEFAULT_ANIMA_MODEL : models[0]! };
}

function outputMetadata(value: unknown) {
  if (!record(value) || !Array.isArray(value.images) || !record(value.images[0]))
    throw new GenerationError('NO_IMAGE', 'The ComfyUI Anima workflow did not save one of its expected output images.', 503);
  const image = value.images[0];
  const filename = image.filename, subfolder = image.subfolder ?? '', type = image.type;
  if (typeof filename !== 'string' || !filename || filename.length > 255 || /[\\/:\x00-\x1f]/.test(filename) || filename.includes('..')
    || typeof subfolder !== 'string' || subfolder.length > 1024 || /[\\:\x00-\x1f]/.test(subfolder)
    || (subfolder && subfolder.split('/').some(part => !part || part === '.' || part === '..')) || !['output', 'temp'].includes(String(type))) {
    throw new GenerationError('INVALID_OUTPUT', 'ComfyUI returned an invalid output image path.', 503);
  }
  return { filename, subfolder, type: String(type) };
}
async function readOutput(profile: Profile, metadata: ReturnType<typeof outputMetadata>, signal: AbortSignal, fetcher: typeof fetch) {
  const url = providerUrl(profile, 'view');
  url.search = new URLSearchParams(metadata).toString();
  return readBounded(await request(profile, url, signal, fetcher), MAX_IMAGE_BYTES, signal);
}
function connectProgress(profile: Profile, clientId: string, options: AnimaRequestOptions, dependencies: ComfyImageDependencies) {
  if (profile.apiKey) return undefined;
  const WebSocketCtor = dependencies.webSocket === null ? undefined : dependencies.webSocket ?? (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketCtor) return undefined;
  try {
    const url = providerUrl(profile, 'ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ clientId }).toString();
    const socket = new WebSocketCtor(url);
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let item: unknown;
      try { item = JSON.parse(event.data); } catch { return; }
      if (!record(item) || typeof item.type !== 'string' || !record(item.data)) return;
      if (item.type === 'execution_start') options.progress?.({ phase: 'generating', percent: 1 });
      if (item.type === 'progress') {
        const value = Number(item.data.value), maximum = Number(item.data.max);
        if (Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0)
          options.progress?.({ phase: 'generating', percent: Math.max(1, Math.min(94, Math.round(value / maximum * 94))) });
      }
      if (item.type === 'executed' && record(item.data.output) && typeof item.data.node === 'string') {
        if (item.data.node === '8') options.progress?.({ phase: 'segmenting', percent: 95 });
        else if (item.data.node === '10' || item.data.node === '13') options.progress?.({ phase: 'saving', percent: 98 });
      }
    });
    socket.addEventListener('error', () => {});
    return socket;
  } catch { return undefined; }
}
async function cancelComfyPrompt(profile: Profile, promptId: string, fetcher: typeof fetch) {
  const signal = AbortSignal.timeout(3_000);
  try { await requestJson(profile, 'queue', signal, fetcher, { delete: [promptId] }, 128 * 1024); } catch { /* queue deletion may already have completed */ }
  try { await requestJson(profile, 'interrupt', signal, fetcher, { prompt_id: promptId }, 128 * 1024); } catch { /* this ComfyUI build may not support targeted interruption */ }
}

/** Generate one local Anima sprite and retain the untouched raster plus BiRefNet foreground mask. */
export async function generateComfyAnimaImage(profile: Profile, prompt: string, signal: AbortSignal,
  options: AnimaRequestOptions, dependencies: ComfyImageDependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  if (profile.workflow !== ANIMA_BUILTIN_WORKFLOW) throw new GenerationError('ANIMA_NOT_CONFIGURED', 'Select the built-in Anima sprite workflow in image-generation settings.', 409);
  if (options.references.length > 5) throw new GenerationError('INVALID_REFERENCE', 'Use at most five reference images.');
  let totalBytes = 0;
  for (const reference of options.references) {
    totalBytes += reference.bytes.length;
    if (!reference.bytes.length || reference.bytes.length > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024)
      throw new GenerationError('INVALID_REFERENCE', 'Anima references must be valid images totaling at most 20 MB.', 413);
  }
  options.progress?.({ phase: 'preparing' });
  const catalog = await getComfyAnimaModels(profile, signal, fetcher);
  const selectedModel = options.animaModel ?? catalog.recommendedModel;
  const clientId = randomUUID();
  const references: UploadedAnimaReference[] = [];
  for (let index = 0; index < options.references.length; index++) {
    signal.throwIfAborted();
    const reference = options.references[index]!;
    const form = new FormData();
    const filename = `illumi-reference-${clientId}-${index + 1}.png`;
    form.append('image', new Blob([new Uint8Array(reference.bytes)], { type: reference.contentType ?? 'image/png' }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const uploaded = await requestJson(profile, 'upload/image', signal, fetcher, form, 128 * 1024);
    const name = uploaded.name, subfolder = uploaded.subfolder ?? '';
    if (typeof name !== 'string' || !name || typeof subfolder !== 'string' || /[\\:\x00-\x1f]/.test(subfolder)
      || (subfolder && subfolder.split('/').some(part => !part || part === '.' || part === '..')))
      throw new GenerationError('INVALID_REFERENCE', 'ComfyUI could not confirm the uploaded project reference.', 503);
    references.push({ name: reference.name, role: reference.role, filename: subfolder ? `${subfolder}/${name}` : name });
  }
  const seed = options.seed ?? randomUUID().replaceAll('-', '').slice(0, 13).split('').reduce((value, digit, index) => value + Number.parseInt(digit, 16) * 16 ** (12 - index), 0);
  const workflow = buildAnimaSpriteWorkflow({ modelName: selectedModel, prompt, imageKind: options.imageKind, transparent: options.transparent, chromaColor: options.chromaColor, seed,
    steps: options.steps ?? 8, cfg: options.cfg ?? 1, samplerName: options.samplerName, scheduler: options.scheduler,
    references, availableModels: catalog.models, availableLoras: catalog.loras, sourcePrefix: `illumi-${clientId.replaceAll('-', '')}` });
  const socket = connectProgress(profile, clientId, options, dependencies);
  let promptId: string | undefined;
  const generationStarted = Date.now();
  try {
    const queued = await requestJson(profile, 'prompt', signal, fetcher, { prompt: workflow, client_id: clientId });
    promptId = typeof queued.prompt_id === 'string' ? queued.prompt_id : undefined;
    if (queued.error || !promptId || !/^[a-zA-Z0-9_-]{1,128}$/.test(promptId))
      throw new GenerationError('INVALID_WORKFLOW', 'ComfyUI rejected the local Anima workflow. Check its installed nodes and model files.', 503);
    options.progress?.({ phase: 'queued', percent: 0 });
    let history: Record<string, unknown> | undefined;
    while (true) {
      signal.throwIfAborted();
      const current = await requestJson(profile, `history/${encodeURIComponent(promptId)}`, signal, fetcher);
      const entry = current[promptId];
      if (record(entry)) {
        const status = entry.status;
        if (record(status) && status.status_str === 'error') throw new GenerationError('EXECUTION_FAILED', 'ComfyUI could not execute the Anima workflow. Check its queue and installed nodes.', 503);
        if ((!record(status) || status.completed === true) && record(entry.outputs)) { history = entry.outputs; break; }
      }
      options.progress?.({ phase: 'generating' });
      await pollDelay(dependencies.pollDelayMs ?? 1_000, signal);
    }
    options.progress?.({ phase: 'processing', percent: 99 });
    const originalMeta = outputMetadata(history[ANIMA_OUTPUT_NODE_IDS.original]);
    const originalBytes = await readOutput(profile, originalMeta, signal, fetcher);
    if ((options.imageKind && options.imageKind !== 'sprite') || !options.transparent) {
      options.progress?.({ phase: 'saving', percent: 100 });
      return { originalBytes, promptId, model: selectedModel, seed, steps: options.steps ?? 8,
        cfg: options.cfg ?? 1, sampler: options.samplerName ?? 'er_sde', scheduler: options.scheduler ?? 'simple',
        loras: [{ name: 'anima-turbo-lora-v0.2.safetensors', strength: 1 },
          ...(options.references.length ? [{ name: 'anima-incontext-character.safetensors', strength: 1 }] : [])],
        segmentationMaskBytes: undefined, refinedForegroundBytes: undefined, segmentationModel: undefined,
        generationMs: Date.now() - generationStarted };
    }
    const maskMeta = outputMetadata(history[ANIMA_OUTPUT_NODE_IDS.mask]);
    const foregroundMeta = outputMetadata(history[ANIMA_OUTPUT_NODE_IDS.foreground]);
    const [segmentationMaskBytes, refinedForegroundBytes] = await Promise.all([
      readOutput(profile, maskMeta, signal, fetcher),
      readOutput(profile, foregroundMeta, signal, fetcher),
    ]);
    options.progress?.({ phase: 'saving', percent: 100 });
    return { originalBytes, segmentationMaskBytes, refinedForegroundBytes, promptId, model: selectedModel, seed, steps: options.steps ?? 8,
      cfg: options.cfg ?? 1, sampler: options.samplerName ?? 'er_sde', scheduler: options.scheduler ?? 'simple', loras: [
        { name: 'anima-turbo-lora-v0.2.safetensors', strength: 1 },
        ...(options.references.length ? [{ name: 'anima-incontext-character.safetensors', strength: 1 }] : []),
      ], segmentationModel: 'BiRefNet-portrait', generationMs: Date.now() - generationStarted };
  } catch (error) {
    if (signal.aborted && promptId) await cancelComfyPrompt(profile, promptId, fetcher);
    throw error;
  } finally { try { socket?.close(); } catch { /* socket may already be closed */ } }
}

/** Generate with local Krea2-Anime v2.0 INT4 using the installed Krea reference encoder.
 * Sprites use the same local BiRefNet node exercised by the tested workflow. */
export async function generateComfyKreaImage(profile: Profile, prompt: string, signal: AbortSignal,
  options: KreaRequestOptions, dependencies: ComfyImageDependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  if (options.references.length > 4) throw new GenerationError('INVALID_REFERENCE', 'Krea accepts at most four reference images. Remove one reference before starting.');
  let totalBytes = 0;
  for (const reference of options.references) {
    totalBytes += reference.bytes.length;
    if (!reference.bytes.length || reference.bytes.length > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024)
      throw new GenerationError('INVALID_REFERENCE', 'Krea references must be valid images totaling at most 20 MB.', 413);
  }
  options.progress?.({ phase: 'preparing' });
  const [modelResult, encoderResult] = await Promise.all([
    requestValue(profile, 'models/diffusion_models', signal, fetcher),
    requestValue(profile, 'object_info/TextEncodeKrea2Reference', signal, fetcher),
  ]);
  if (!namesFrom(modelResult).some(value => value === KREA_MODEL || (record(value) && value.name === KREA_MODEL)))
    throw new GenerationError('KREA_MODEL_UNAVAILABLE', 'The configured local Krea2-Anime v2.0 INT4 model is not installed in ComfyUI.', 503);
  if (!record(encoderResult) || !record(encoderResult.TextEncodeKrea2Reference))
    throw new GenerationError('KREA_NODES_UNAVAILABLE', 'The Krea reference encoder is not installed in ComfyUI.', 503);

  const clientId = randomUUID();
  const references: Array<{ filename: string; role: UploadedAnimaReference['role']; name: string }> = [];
  for (let index = 0; index < options.references.length; index++) {
    signal.throwIfAborted();
    const reference = options.references[index]!;
    const form = new FormData();
    const filename = `illumi-krea-reference-${clientId}-${index + 1}.png`;
    form.append('image', new Blob([new Uint8Array(reference.bytes)], { type: reference.contentType ?? 'image/png' }), filename);
    form.append('type', 'input'); form.append('overwrite', 'false');
    const uploaded = await requestJson(profile, 'upload/image', signal, fetcher, form, 128 * 1024);
    const name = uploaded.name, subfolder = uploaded.subfolder ?? '';
    if (typeof name !== 'string' || !name || typeof subfolder !== 'string' || /[\\:\x00-\x1f]/.test(subfolder)
      || (subfolder && subfolder.split('/').some(part => !part || part === '.' || part === '..')))
      throw new GenerationError('INVALID_REFERENCE', 'ComfyUI could not confirm the uploaded Krea reference.', 503);
    references.push({ name: reference.name, role: reference.role, filename: subfolder ? `${subfolder}/${name}` : name });
  }
  const seed = options.seed ?? randomUUID().replaceAll('-', '').slice(0, 13).split('').reduce((value, digit, index) => value + Number.parseInt(digit, 16) * 16 ** (12 - index), 0);
  const workflow = buildKreaReferenceWorkflow({ prompt, imageKind: options.imageKind, transparent: options.transparent, seed, steps: options.steps, cfg: options.cfg,
    references, availableModels: namesFrom(modelResult), sourcePrefix: `illumi-krea-${clientId.replaceAll('-', '')}` });
  const generationStarted = Date.now();
  let promptId: string | undefined;
  try {
    const queued = await requestJson(profile, 'prompt', signal, fetcher, { prompt: workflow, client_id: clientId });
    promptId = typeof queued.prompt_id === 'string' ? queued.prompt_id : undefined;
    if (queued.error || !promptId || !/^[a-zA-Z0-9_-]{1,128}$/.test(promptId))
      throw new GenerationError('INVALID_WORKFLOW', 'ComfyUI rejected the Krea reference workflow. Check its installed nodes and model files.', 503);
    options.progress?.({ phase: 'queued', percent: 0 });
    let outputs: Record<string, unknown> | undefined;
    while (true) {
      signal.throwIfAborted();
      const current = await requestJson(profile, `history/${encodeURIComponent(promptId)}`, signal, fetcher);
      const entry = current[promptId];
      if (record(entry)) {
        const status = entry.status;
        if (record(status) && status.status_str === 'error')
          throw new GenerationError('EXECUTION_FAILED', 'ComfyUI could not execute the Krea reference workflow. Check its queue and installed nodes.', 503);
        if ((!record(status) || status.completed === true) && record(entry.outputs)) { outputs = entry.outputs; break; }
      }
      options.progress?.({ phase: 'generating' });
      await pollDelay(dependencies.pollDelayMs ?? 1_000, signal);
    }
    const completedOutputs = outputs;
    if (!completedOutputs) throw new GenerationError('NO_IMAGE', 'ComfyUI did not return the finished Krea images.', 503);
    const originalMeta = outputMetadata(completedOutputs[KREA_OUTPUT_NODE_IDS.original]);
    const originalBytes = await readOutput(profile, originalMeta, signal, fetcher);
    let bytes = originalBytes;
    if (options.imageKind === 'sprite' && options.transparent) {
      options.progress?.({ phase: 'segmenting', percent: 95 });
      const spriteMeta = outputMetadata(completedOutputs[KREA_OUTPUT_NODE_IDS.sprite]);
      bytes = await readOutput(profile, spriteMeta, signal, fetcher);
    }
    options.progress?.({ phase: 'saving', percent: 100 });
    return { bytes, originalBytes, promptId, model: KREA_MODEL, seed, steps: options.steps ?? 8, cfg: options.cfg ?? 1,
      sampler: 'euler', scheduler: 'simple', segmentationModel: options.imageKind === 'sprite' && options.transparent ? 'BiRefNet-portrait' : undefined,
      generationMs: Date.now() - generationStarted };
  } catch (error) {
    if (signal.aborted && promptId) await cancelComfyPrompt(profile, promptId, fetcher);
    throw error;
  }
}

/** User-configured graph is data; model prompt can only replace string input values. */
export async function generateComfyImage(profile: Profile, prompt: string, signal: AbortSignal, dependencies: ProviderDependencies = {}) {
  if (profile.workflow === ANIMA_BUILTIN_WORKFLOW) throw new GenerationError('ANIMA_SPRITE_ONLY', 'The built-in Anima workflow currently produces character sprites only.', 409);
  const fetcher = dependencies.fetch ?? fetch;
  const queued = await requestJson(profile, 'prompt', signal, fetcher, { prompt: workflowWithPrompt(profile.workflow, prompt), client_id: randomUUID() });
  const promptId = queued.prompt_id;
  if (queued.error || typeof promptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(promptId))
    throw new GenerationError('INVALID_WORKFLOW', 'ComfyUI rejected the configured workflow. Check its nodes and model files.', 503);
  try {
    while (true) {
      signal.throwIfAborted();
      const history = await requestJson(profile, `history/${encodeURIComponent(promptId)}`, signal, fetcher);
      const entry = history[promptId];
      if (record(entry)) {
        const status = entry.status;
        if (record(status) && status.status_str === 'error') throw new GenerationError('EXECUTION_FAILED', 'ComfyUI could not execute the workflow. Check its queue and installed nodes.', 503);
        // History is written after execution; old Comfy versions may omit status.
        if (!record(status) || status.completed === true) {
          if (!record(entry.outputs)) throw new GenerationError('NO_IMAGE', 'The ComfyUI workflow produced no output image.', 503);
          for (const output of Object.values(entry.outputs)) {
            if (!record(output) || !Array.isArray(output.images)) continue;
            for (const image of output.images) {
              const metadata = outputMetadata({ images: [image] });
              return { bytes: await readOutput(profile, metadata, signal, fetcher), promptId };
            }
          }
          throw new GenerationError('NO_IMAGE', 'The ComfyUI workflow produced no output image. Add an image output node.', 503);
        }
      }
      await pollDelay(dependencies.pollDelayMs ?? 1000, signal);
    }
  } catch (error) {
    if (signal.aborted) await cancelComfyPrompt(profile, promptId, fetcher);
    throw error;
  }
}
export async function testComfyConnection(profile: Profile, signal: AbortSignal, fetcher = fetch) {
  const response = await requestJson(profile, 'system_stats', signal, fetcher);
  if (!record(response.system) || !Array.isArray(response.devices)) throw new GenerationError('INVALID_RESPONSE', 'The endpoint did not return ComfyUI system information.', 503);
  if (profile.workflow === ANIMA_BUILTIN_WORKFLOW) await getComfyAnimaModels(profile, signal, fetcher);
}
