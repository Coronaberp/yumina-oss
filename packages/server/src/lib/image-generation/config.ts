import { z } from 'zod';
import { IS_LOCAL_EDITION } from '../env.js';
import { allowedEndpointHostname } from './endpoint-policy.js';
export const ANIMA_BUILTIN_WORKFLOW = "__yumina_anima_vn_sprite_v1__";
export const providers = ['comfyui', 'forgeneo'] as const;
export type ImageProvider = typeof providers[number];
export type ImageKind = 'sprite' | 'background' | 'image';
export type StudioImageWorkflow = 'anima' | 'krea' | 'codex';
export type StudioImageContentRating = 'sfw' | 'nsfw';
export class GenerationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 409 | 413 | 429 | 503 = 400) { super(message); }
}
export type Profile = { enabled: boolean; baseUrl: string; apiKey: string | null; workflow: string; model: string; keyUnreadable?: boolean };
export type GenerationCredentials = { activeProvider: ImageProvider; configs: Record<ImageProvider, Profile> };
export const settingsInput = z.object({ provider: z.enum(providers), enabled: z.boolean(), baseUrl: z.string().max(2048),
  apiKey: z.string().max(4096).optional(), clearKey: z.boolean().optional(), workflow: z.string().max(256_000).optional(),
  workflowMode: z.enum(['custom', 'anima']).optional(), model: z.string().max(200).optional(), makeActive: z.boolean().optional() }).strict();
export type SettingsInput = z.infer<typeof settingsInput>;
export function defaultGenerationConfig(): GenerationCredentials {
  return { activeProvider: 'comfyui', configs: {
    comfyui: { enabled: false, baseUrl: 'http://127.0.0.1:8188', apiKey: null, workflow: '', model: '' },
    forgeneo: { enabled: false, baseUrl: 'http://127.0.0.1:7860', apiKey: null, workflow: '', model: '' },
  } };
}
export function normalizeGenerationUrl(value: string, provider: ImageProvider, localEdition = IS_LOCAL_EDITION): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new GenerationError('INVALID_URL', 'Enter a valid provider base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname))
    throw new GenerationError('INVALID_URL', 'Use an HTTP(S) URL without credentials, query parameters, or a fragment.');
  if (provider === 'forgeneo' && url.protocol !== 'https:' && !localEdition)
    throw new GenerationError('INVALID_URL', 'Remote Forge Neo endpoints must use HTTPS.');
  if (!allowedEndpointHostname(url.hostname, { allowPrivate: (provider === 'comfyui' || provider === 'forgeneo') && localEdition }))
    throw new GenerationError('INVALID_URL', 'Use a public image endpoint. Local ComfyUI and Forge Neo endpoints are supported only in local installations.');
  // DNS addresses are validated and pinned again for every actual outbound request.
  return (url.origin + url.pathname).replace(/\/+$/, '');
}
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function parseWorkflow(text: string): Record<string, unknown> {
  let graph: unknown;
  try { graph = JSON.parse(text); } catch { throw new GenerationError('INVALID_WORKFLOW', 'Paste valid ComfyUI API-format workflow JSON.'); }
  if (!record(graph) || !Object.keys(graph).length || Object.keys(graph).length > 2000)
    throw new GenerationError('INVALID_WORKFLOW', 'Use a ComfyUI API-format graph containing 1–2000 nodes.');
  let placeholders = 0;
  function visit(value: unknown, depth: number): void {
    if (depth > 32) throw new GenerationError('INVALID_WORKFLOW', 'The ComfyUI workflow is too deeply nested.');
    if (typeof value === 'string' && value.includes('{{prompt}}')) placeholders++;
    else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
    else if (record(value)) Object.values(value).forEach(v => visit(v, depth + 1));
  }
  for (const node of Object.values(graph)) {
    if (!record(node) || typeof node.class_type !== 'string' || !node.class_type || !record(node.inputs))
      throw new GenerationError('INVALID_WORKFLOW', 'Export the API-format workflow, not the editor workflow.');
    visit(node.inputs, 0);
  }
  if (!placeholders) throw new GenerationError('INVALID_WORKFLOW', 'Add {{prompt}} inside a text input value in the ComfyUI workflow.');
  return graph;
}
export function workflowWithPrompt(text: string, prompt: string): Record<string, unknown> {
  const graph = parseWorkflow(text);
  function replace(value: unknown): unknown {
    if (typeof value === 'string') return value.replaceAll('{{prompt}}', prompt);
    if (Array.isArray(value)) return value.map(replace);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  }
  // Only input values are prompt slots. Graph keys and class names cannot be changed by model text.
  return Object.fromEntries(Object.entries(graph).map(([id, raw]) => {
    const node = raw as Record<string, unknown>;
    return [id, { ...node, inputs: replace(node.inputs) }];
  }));
}
export function mergeGenerationSettings(current: GenerationCredentials, input: SettingsInput, localEdition = IS_LOCAL_EDITION): GenerationCredentials {
  const previous = current.configs[input.provider];
  const key = input.apiKey?.trim();
  if (key && /[\r\n]/.test(key)) throw new GenerationError('INVALID_KEY', 'The API key contains invalid characters.');
  if (input.clearKey && key) throw new GenerationError('INVALID_KEY', 'Clear the key or replace it in one request.');
  if (previous.keyUnreadable && !key && !input.clearKey) throw new GenerationError('CREDENTIALS_UNREADABLE', 'Clear or replace the saved API key before updating this provider.', 503);
  if (previous.apiKey && !key && !input.clearKey && new URL(previous.baseUrl).origin !== new URL(normalizeGenerationUrl(input.baseUrl, input.provider, localEdition)).origin)
    throw new GenerationError('KEY_REQUIRED', 'Replace or clear the API key when changing the provider host.');
  const profile: Profile = { ...previous, enabled: input.enabled, baseUrl: normalizeGenerationUrl(input.baseUrl, input.provider, localEdition),
    apiKey: input.clearKey ? null : key || previous.apiKey, keyUnreadable: false };
  if (input.provider === 'comfyui') {
    if (input.model !== undefined) throw new GenerationError('INVALID_SETTINGS', 'ComfyUI uses the model in its workflow.');
    if (input.workflowMode === 'anima') profile.workflow = ANIMA_BUILTIN_WORKFLOW;
    else if (input.workflowMode === 'custom') profile.workflow = input.workflow?.trim() ?? (profile.workflow === ANIMA_BUILTIN_WORKFLOW ? '' : profile.workflow);
    else if (input.workflow !== undefined) profile.workflow = input.workflow.trim();
    if (profile.workflow && profile.workflow !== ANIMA_BUILTIN_WORKFLOW) parseWorkflow(profile.workflow);
  } else {
    if (input.workflow !== undefined) throw new GenerationError('INVALID_SETTINGS', 'Forge Neo does not use a ComfyUI workflow.');
    if (input.model !== undefined) profile.model = input.model.trim();
    if (profile.model && (profile.model.length > 200 || /[\r\n\x00-\x1f]/.test(profile.model)))
      throw new GenerationError('INVALID_MODEL', 'Enter a valid Forge Neo checkpoint name.');
    if (profile.apiKey && !/^([^:\r\n]+):([^\r\n]*)$/.test(profile.apiKey))
      throw new GenerationError('INVALID_KEY', 'Forge Neo authentication must use username:password.');
  }
  return { activeProvider: input.makeActive ? input.provider : current.activeProvider, configs: { ...current.configs, [input.provider]: profile } };
}
export function configured(profile: Profile, provider: ImageProvider): boolean {
  return profile.enabled && !profile.keyUnreadable && !!profile.baseUrl && (provider === 'comfyui' ? (!!profile.workflow || profile.workflow === ANIMA_BUILTIN_WORKFLOW) : true);
}
export function publicGenerationConfig(state: GenerationCredentials) {
  const anima = state.configs.comfyui.workflow === ANIMA_BUILTIN_WORKFLOW;
  return { activeProvider: state.activeProvider, configs: {
    comfyui: { enabled: state.configs.comfyui.enabled, baseUrl: state.configs.comfyui.baseUrl, workflow: anima ? '' : state.configs.comfyui.workflow,
      workflowMode: anima ? 'anima' as const : 'custom' as const,
      hasKey: (!!state.configs.comfyui.apiKey || !!state.configs.comfyui.keyUnreadable), configured: configured(state.configs.comfyui, 'comfyui') },
    forgeneo: { enabled: state.configs.forgeneo.enabled, baseUrl: state.configs.forgeneo.baseUrl, model: state.configs.forgeneo.model,
      hasKey: (!!state.configs.forgeneo.apiKey || !!state.configs.forgeneo.keyUnreadable), configured: configured(state.configs.forgeneo, 'forgeneo') },
  } };
}
export function generationStatus(state: GenerationCredentials) {
  const workflow = state.configs.comfyui.workflow;
  return { activeProvider: state.activeProvider, configs: {
    comfyui: { enabled: state.configs.comfyui.enabled, configured: configured(state.configs.comfyui, 'comfyui'),
      workflowMode: workflow === ANIMA_BUILTIN_WORKFLOW ? 'anima' as const : 'custom' as const,
      hasKey: (!!state.configs.comfyui.apiKey || !!state.configs.comfyui.keyUnreadable), workflowSummary: workflow === ANIMA_BUILTIN_WORKFLOW ? 'Anima VN sprite pipeline'
        : workflow ? `${Object.keys(parseWorkflow(workflow)).length} nodes` : 'No workflow' },
    forgeneo: { enabled: state.configs.forgeneo.enabled, configured: configured(state.configs.forgeneo, 'forgeneo'), hasKey: (!!state.configs.forgeneo.apiKey || !!state.configs.forgeneo.keyUnreadable), model: state.configs.forgeneo.model },
  } };
}
export interface GenerationRepository {
  get(userId: string): Promise<GenerationCredentials>;
  update(userId: string, input: SettingsInput): Promise<GenerationCredentials>;
  clear(userId: string, provider: ImageProvider): Promise<GenerationCredentials>;
}
export const generationInput = z.object({ provider: z.enum(providers).optional(), prompt: z.string().trim().min(1).max(12_000), imageKind: z.enum(['sprite', 'background', 'image']),
  requestId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/).optional(), animaModel: z.string().max(200).optional(),
  imageWorkflow: z.enum(['anima', 'krea', 'codex']).optional(), contentRating: z.enum(['sfw', 'nsfw']).optional(),
  seedMode: z.enum(['random', 'fixed']).optional(), cfg: z.number().min(0.5).max(8).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), steps: z.number().int().min(1).max(20).optional(),
  samplerName: z.enum(['er_sde', 'euler']).optional(), transparent: z.boolean().optional(), adaptiveChroma: z.boolean().optional() });
export type ResolvedAnimaReference = { name: string; role: import('../studio-image-references.js').StudioReferenceRole; bytes: Buffer; contentType?: string; key: string };
export type GenerationProgress = { phase: 'preparing' | 'queued' | 'generating' | 'segmenting' | 'processing' | 'saving'; percent?: number };
export type GenerationInput = z.infer<typeof generationInput> & { signal?: AbortSignal; worldId?: string;
  referenceImages?: import('../studio-image-references.js').StudioImageReference[]; resolvedReferences?: ResolvedAnimaReference[];
  chromaColor?: string; progress?: (progress: GenerationProgress) => void };
export type GeneratedSource = { provider: ImageProvider | 'codex'; imageKind: ImageKind; prompt: string; requestId?: string; promptId?: string; model?: string; reasoningEffort?: string;
  imageWorkflow?: StudioImageWorkflow; contentRating?: StudioImageContentRating; transparent?: boolean;
  attribution: string; createdAt: string; width?: number; height?: number; greenRemoved: boolean; referenceKeys?: string[];
  assetRole?: 'original' | 'final'; originalAssetId?: string; seed?: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string;
  loras?: Array<{ name: string; strength: number }>; chromaColor?: string; segmentationModel?: string; processingStatus?: 'complete' | 'review_required';
  processingMs?: number; generationMs?: number; foregroundCoverage?: number; transparentCorners?: boolean; residualBackgroundRatio?: number;
  maskDisagreementRatio?: number; detachedForegroundRatio?: number; interiorChromaPixelsRemoved?: number; reviewRequired?: boolean; reviewReasons?: string[];
  requestedToActualDeltaE?: number; actualBackgroundColor?: string; backgroundMismatch?: boolean;
  referenceRoles?: Array<{ key: string; name: string; role: string }> };
export type GeneratedAsset = { id: string; ref: string; filename: string; source: GeneratedSource };
