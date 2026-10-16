import { buildGreenScreenPrompt, removeGreenBackground } from '../image-sources/green-screen.js';
import { imageGenerationRepository } from './repository.js';
import { generatedImageStorage } from './storage.js';
import { createImageGenerationService, assertLocalImageGenerationEnabled } from './service.js';
import { localImageGenerationEnabled } from './admin-controls.js';
import { createCodexImageService, codexImagesEnabled, CODEX_IMAGE_LABEL } from './codex-service.js';
import { env } from '../env.js';
import { GenerationError, type GenerationInput, type ImageProvider } from './config.js';
import { loadStudioImageReferenceInputs } from '../studio-image-references.js';
import { selectAdaptiveChromaColor } from '../image-sources/adaptive-sprite.js';
import { checkLocalImageRequest } from './local-image-safety.js';
import { animaModelSupportsNsfw } from './anima-workflow.js';
import { createNsfwReferencePrompt } from './reference-prompt.js';
import { resolveStudioReferenceVisionProvider } from '../studio-nsfw-provider.js';
const prepareNsfwPrompt = createNsfwReferencePrompt({ resolveProvider: resolveStudioReferenceVisionProvider,
  loadReferences: (userId, input) => loadStudioImageReferenceInputs(userId, input.worldId, input.referenceImages ?? [], input.signal) });
export const imageGenerationService = createImageGenerationService({ repository: imageGenerationRepository,
  storage: generatedImageStorage, buildGreenScreenPrompt, removeGreenBackground, prepareNsfwPrompt, localGenerationEnabled: localImageGenerationEnabled });
export const getImageGenerationConfig = (userId: string) => imageGenerationService.getConfig(userId);
export const getImageGenerationStatus = (userId: string) => imageGenerationService.getStatus(userId);
export const generateConfiguredImage = (userId: string, input: Parameters<typeof imageGenerationService.generate>[1]) => imageGenerationService.generate(userId, input);
const codexImages = createCodexImageService({ storage: generatedImageStorage, enabled: codexImagesEnabled, command: () => env.YUMINA_STUDIO_CODEX_BIN });
export async function getStudioImageGenerationStatus(userId: string) {
  const personal = await getImageGenerationStatus(userId);
  const enabled = codexImagesEnabled();
  return { ...personal, activeProvider: enabled ? 'codex' as const : personal.activeProvider, configs: { ...personal.configs,
    codex: { enabled, configured: enabled, model: CODEX_IMAGE_LABEL, reasoningEffort: 'xhigh', sharedAccount: true } } };
}
export async function generateStudioImage(userId: string, input: Omit<GenerationInput, 'provider'> & { provider?: ImageProvider | 'codex' }) {
  const state = await getImageGenerationConfig(userId);
  const workflowProvider = input.imageWorkflow === 'anima' || input.imageWorkflow === 'krea' ? 'comfyui'
    : input.imageWorkflow === 'codex' ? 'codex' : undefined;
  const provider = input.provider ?? workflowProvider ?? state.activeProvider;
  if (provider === 'codex') {
    if (input.contentRating === 'nsfw') throw new GenerationError('NSFW_MODEL_REQUIRED', 'Codex image generation is SFW-only. Choose Krea or an installed NSFW-capable Anima checkpoint.', 400);
    return codexImages.generate(userId, { ...input, provider: undefined });
  }
  if (input.imageWorkflow === 'codex') throw new GenerationError('INVALID_WORKFLOW', 'Choose the Codex image path for Codex image generation.');
  if (provider === 'comfyui') assertLocalImageGenerationEnabled(localImageGenerationEnabled());

  const workflow = input.imageWorkflow ?? (provider === 'comfyui' && state.configs.comfyui.workflowMode === 'anima' ? 'anima' : undefined);
  const localNsfwCapable = provider === 'comfyui' && (workflow === 'krea'
    || (workflow === 'anima' && animaModelSupportsNsfw(input.animaModel ?? '')));
  if (input.contentRating === 'nsfw' && !localNsfwCapable)
    throw new GenerationError('NSFW_MODEL_REQUIRED', 'Choose Krea or an installed Anima checkpoint marked NSFW-capable for this request.', 400);
  await checkLocalImageRequest(input.prompt, input.signal, localNsfwCapable && input.contentRating === 'nsfw');

  if (input.referenceImages?.length) {
    if (provider !== 'comfyui' || (workflow !== 'anima' && workflow !== 'krea'))
      throw new GenerationError('UNSUPPORTED_REFERENCES', 'Choose local Anima, local Krea, or Codex to use project references.');
    const resolvedReferences = await loadStudioImageReferenceInputs(userId, input.worldId, input.referenceImages, input.signal);
    const identity = resolvedReferences.find(reference => reference.role === 'identity');
    const chroma = workflow === 'anima' && input.imageKind === 'sprite' && input.transparent === true
      ? await selectAdaptiveChromaColor(identity?.bytes, input.signal) : undefined;
    return generateConfiguredImage(userId, { ...input, provider, imageWorkflow: workflow,
      ...(chroma ? { chromaColor: chroma.hex } : {}), resolvedReferences } as GenerationInput);
  }
  return generateConfiguredImage(userId, { ...input, provider, ...(workflow ? { imageWorkflow: workflow } : {}) } as GenerationInput);
}
