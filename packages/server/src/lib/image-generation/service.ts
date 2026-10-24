import { ANIMA_BUILTIN_WORKFLOW, configured, generationInput, generationStatus, publicGenerationConfig, settingsInput,
  GenerationError, type GenerationInput, type GenerationRepository, type GeneratedAsset, type GeneratedSource, type ImageProvider } from './config.js';
import { combinedSignal, safeGenerationFailure, type ProviderDependencies } from './transport.js';
import { generateComfyAnimaImage, generateComfyImage, getComfyAnimaModels, testComfyConnection } from './comfyui.js';
import { generateComfyKreaImage } from './comfyui.js';
import { animaModelSupportsNsfw } from './anima-workflow.js';
import { generateForgeNeoImage, testForgeNeoConnection } from './forgeneo.js';
import { extractAdaptiveTransparentSprite, selectAdaptiveChromaColor } from '../image-sources/adaptive-sprite.js';
export type GeneratedStorage = {
  preflight(userId: string, signal: AbortSignal): Promise<void>;
  findRequest?(userId: string, requestId: string, signal: AbortSignal): Promise<GeneratedAsset | undefined>;
  claimRequest?(userId: string, requestId: string, signal: AbortSignal): Promise<GeneratedAsset | undefined>;
  failRequest?(userId: string, requestId: string): Promise<void>;
  validate(bytes: Buffer, signal: AbortSignal): Promise<void>;
  save(userId: string, bytes: Buffer, source: GeneratedSource, signal: AbortSignal,
    artifacts?: { originalBytes?: Buffer; originalSource?: GeneratedSource }): Promise<GeneratedAsset>;
};
export type GenerationDependencies = ProviderDependencies & { repository: GenerationRepository; storage: GeneratedStorage;
  buildGreenScreenPrompt(prompt: string): string; removeGreenBackground(bytes: Buffer, signal?: AbortSignal): Promise<Buffer>;
  now?: () => number; localGenerationEnabled?: () => boolean; prepareNsfwPrompt?: (userId: string, input: GenerationInput) => Promise<string> };
export function assertLocalImageGenerationEnabled(enabled: boolean) {
  if (!enabled) throw new GenerationError('LOCAL_IMAGE_GENERATION_DISABLED',
    'Anima and Krea image generation is paused by the administrator. Re-enable it in Administration → Image generation.', 409);
}
export function createImageGenerationService(dependencies: GenerationDependencies) {
  const active = new Set<string>();
  const recent = new Map<string, number[]>();
  const now = dependencies.now ?? Date.now;
  const localEnabled = () => dependencies.localGenerationEnabled?.() ?? true;
  function withAdminControls<T extends { configs: { comfyui: { configured: boolean } } }>(state: T) {
    const adminDisabled = !localEnabled();
    return { ...state, configs: { ...state.configs, comfyui: { ...state.configs.comfyui,
      configured: state.configs.comfyui.configured && !adminDisabled, adminDisabled } } };
  }
  async function requireProfile(userId: string, provider?: ImageProvider) {
    const state = await dependencies.repository.get(userId);
    const selected = provider ?? state.activeProvider;
    if (selected === 'comfyui') assertLocalImageGenerationEnabled(localEnabled());
    const profile = state.configs[selected];
    if (profile.keyUnreadable) throw new GenerationError('CREDENTIALS_UNREADABLE', 'Saved image-generation credentials could not be opened. Clear or replace the API key in Settings → AI Configuration.', 503);
    if (!configured(profile, selected)) throw new GenerationError('NOT_CONFIGURED', `Enable and configure ${selected === 'comfyui' ? 'ComfyUI' : 'Forge Neo'} in Settings → AI Configuration.`, 409);
    return { profile, selected };
  }
  return {
    async getConfig(userId: string) { return withAdminControls(publicGenerationConfig(await dependencies.repository.get(userId))); },
    async getStatus(userId: string) { return withAdminControls(generationStatus(await dependencies.repository.get(userId))); },
    async listAnimaModels(userId: string, callerSignal?: AbortSignal) {
      const signal = combinedSignal(callerSignal, 15_000);
      try {
        const { profile } = await requireProfile(userId, 'comfyui');
        if (profile.workflow !== ANIMA_BUILTIN_WORKFLOW) throw new GenerationError('ANIMA_NOT_CONFIGURED', 'Select the built-in Anima sprite workflow to browse its local checkpoints.', 409);
        const catalog = await getComfyAnimaModels(profile, signal, dependencies.fetch);
        return { ...catalog, modelOptions: catalog.models.map(name => ({ name, nsfwCapable: animaModelSupportsNsfw(name) })) };
      } catch (error) { throw safeGenerationFailure(error, signal); }
    },
    async updateConfig(userId: string, raw: unknown) { return withAdminControls(publicGenerationConfig(await dependencies.repository.update(userId, settingsInput.parse(raw)))); },
    async clearConfig(userId: string, provider: ImageProvider) { return withAdminControls(publicGenerationConfig(await dependencies.repository.clear(userId, provider))); },
    async test(userId: string, provider: ImageProvider, callerSignal?: AbortSignal) {
      const signal = combinedSignal(callerSignal, 15_000);
      try {
        const { profile, selected } = await requireProfile(userId, provider);
        if (selected === 'comfyui') await testComfyConnection(profile, signal, dependencies.fetch);
        else await testForgeNeoConnection(profile, signal, dependencies.fetch);
      } catch (error) { throw safeGenerationFailure(error, signal); }
    },
    /** Caller invokes only after creator confirmation; this method can spend provider credits. */
    async generate(userId: string, raw: GenerationInput): Promise<GeneratedAsset> {
      const input = generationInput.parse(raw);
      if (input.transparent && input.imageKind !== 'sprite')
        throw new GenerationError('INVALID_TRANSPARENCY', 'Transparent background extraction is supported for character sprites. Keep scene backgrounds opaque.');
      const signal = combinedSignal(raw.signal, dependencies.timeoutMs);
      signal.throwIfAborted();
      if (input.requestId && dependencies.storage.findRequest) {
        const saved = await dependencies.storage.findRequest(userId, input.requestId, signal);
        if (saved) return saved;
      }
      if (active.has(userId) || active.size >= 4) throw new GenerationError('GENERATION_BUSY', 'An image is already being generated. Try again shortly.', 429);
      const timestamp = now();
      // Prune idle users so the rate-limit map does not grow with all historical creators.
      for (const [id, times] of recent) if (!times.some(time => timestamp - time < 60_000)) recent.delete(id);
      const times = (recent.get(userId) ?? []).filter(time => timestamp - time < 60_000);
      if (times.length >= 3) throw new GenerationError('RATE_LIMITED', 'Generate at most three images per minute. Try again shortly.', 429);
      active.add(userId);
      let claimed = false;
      try {
        const { profile, selected } = await requireProfile(userId, input.provider);
        const textOnly = input.contentRating === 'nsfw';
        const hasReferences = !!raw.referenceImages?.length || !!raw.resolvedReferences?.length;
        if (textOnly && hasReferences) {
          if (!dependencies.prepareNsfwPrompt) throw new GenerationError('REFERENCE_VISION_REQUIRED', 'A vision model must describe NSFW references before text-to-image generation. No image was generated.', 409);
          raw.progress?.({ phase: 'preparing' });
          input.prompt = generationInput.shape.prompt.parse(await dependencies.prepareNsfwPrompt(userId, { ...raw, ...input, signal }));
          signal.throwIfAborted();
        }
        const generationReferences = textOnly ? [] : raw.resolvedReferences ?? [];
        if (input.requestId && dependencies.storage.claimRequest) {
          const existing = await dependencies.storage.claimRequest(userId, input.requestId, signal);
          if (existing) return existing;
          claimed = true;
        }
        await dependencies.storage.preflight(userId, signal);
        signal.throwIfAborted();
        recent.set(userId, [...times, timestamp]);
        let bytes: Buffer; let promptId: string | undefined;
        let backgroundRemoved = false;
        const transparentSprite = input.imageKind === 'sprite' && input.transparent === true;
        let storedArtifacts: { originalBytes?: Buffer; originalSource?: GeneratedSource } | undefined;
        let imageMetadata: Partial<GeneratedSource> = {};
        if (selected === 'comfyui') {
          const imageWorkflow = input.imageWorkflow ?? (profile.workflow === ANIMA_BUILTIN_WORKFLOW ? 'anima' : undefined);
          if (imageWorkflow === 'anima') {
            if (profile.workflow !== ANIMA_BUILTIN_WORKFLOW) throw new GenerationError('ANIMA_NOT_CONFIGURED', 'Choose the Anima workflow in image-generation settings before using its checkpoints.', 409);
            if (!textOnly && raw.referenceImages?.length && !generationReferences.length) throw new GenerationError('INVALID_REFERENCE', 'The selected Anima reference images could not be loaded. No image was generated.');
            const identity = generationReferences.find(reference => reference.role === 'identity');
            const chroma = transparentSprite
              ? raw.chromaColor ? { hex: raw.chromaColor } : await selectAdaptiveChromaColor(identity?.bytes, signal) : { hex: '#ff00ff' };
            const generated = await generateComfyAnimaImage(profile, input.prompt, signal, {
              animaModel: input.animaModel, imageKind: input.imageKind, transparent: transparentSprite, chromaColor: chroma.hex, seed: input.seed, steps: input.steps,
              cfg: input.cfg, samplerName: input.samplerName,
              references: generationReferences.map(reference => ({ name: reference.name, role: reference.role, bytes: reference.bytes, contentType: reference.contentType })),
              progress: raw.progress,
            }, dependencies);
            await dependencies.storage.validate(generated.originalBytes, signal);
            promptId = generated.promptId;
            const referenceRoles = raw.resolvedReferences?.map(reference => ({ key: reference.key, name: reference.name, role: reference.role }));
            if (transparentSprite) {
              if (!generated.segmentationMaskBytes || !generated.refinedForegroundBytes)
                throw new GenerationError('SPRITE_PROCESSING_FAILED', 'Anima did not return its transparency masks. No sprite was saved.', 503);
              await dependencies.storage.validate(generated.segmentationMaskBytes, signal);
              await dependencies.storage.validate(generated.refinedForegroundBytes, signal);
              const processingStarted = now();
              const extracted = await extractAdaptiveTransparentSprite(generated.originalBytes, generated.segmentationMaskBytes,
                { color: chroma.hex, refinedForegroundBytes: generated.refinedForegroundBytes, identityReferenceBytes: identity?.bytes }, signal);
              bytes = extracted.bytes;
              imageMetadata = { imageWorkflow, model: generated.model, seed: generated.seed, steps: generated.steps, cfg: generated.cfg,
                sampler: generated.sampler, scheduler: generated.scheduler, loras: generated.loras, chromaColor: chroma.hex,
                segmentationModel: generated.segmentationModel, processingStatus: extracted.quality.reviewRequired ? 'review_required' : 'complete',
                processingMs: now() - processingStarted, generationMs: generated.generationMs,
                foregroundCoverage: extracted.quality.foregroundCoverage, transparentCorners: extracted.quality.transparentCorners,
                residualBackgroundRatio: extracted.quality.residualBackgroundRatio, maskDisagreementRatio: extracted.quality.maskDisagreementRatio,
                detachedForegroundRatio: extracted.quality.detachedForegroundRatio,
                interiorChromaPixelsRemoved: extracted.quality.interiorChromaPixelsRemoved, reviewRequired: extracted.quality.reviewRequired,
                reviewReasons: extracted.quality.reviewReasons, requestedToActualDeltaE: extracted.quality.requestedToActualDeltaE,
                actualBackgroundColor: extracted.quality.actualBackgroundColor, backgroundMismatch: extracted.quality.backgroundMismatch, referenceRoles,
                transparent: true };
            } else {
              bytes = generated.originalBytes;
              imageMetadata = { imageWorkflow, model: generated.model, seed: generated.seed, steps: generated.steps, cfg: generated.cfg,
                sampler: generated.sampler, scheduler: generated.scheduler, loras: generated.loras, generationMs: generated.generationMs,
                processingStatus: 'complete', referenceRoles, transparent: false };
            }
            if (transparentSprite) storedArtifacts = { originalBytes: generated.originalBytes, originalSource: { provider: 'comfyui', imageKind: 'image',
              prompt: input.prompt, model: generated.model, imageWorkflow, seed: generated.seed, steps: generated.steps, cfg: generated.cfg,
              sampler: generated.sampler, scheduler: generated.scheduler, loras: generated.loras, ...(input.imageKind === 'sprite' ? { chromaColor: chroma.hex } : {}),
              attribution: 'Untouched source raster from the local ComfyUI Anima workflow.', createdAt: new Date(now()).toISOString(),
              greenRemoved: false, referenceKeys: raw.referenceImages?.map(reference => reference.assetRef ?? reference.key), referenceRoles } };
          } else if (imageWorkflow === 'krea') {
            if (!textOnly && raw.referenceImages?.length && !generationReferences.length) throw new GenerationError('INVALID_REFERENCE', 'The selected Krea reference images could not be loaded. No image was generated.');
            const generated = await generateComfyKreaImage(profile, input.prompt, signal, {
              imageKind: input.imageKind, transparent: transparentSprite, seed: input.seed, steps: input.steps, cfg: input.cfg,
              references: generationReferences.map(reference => ({ name: reference.name, role: reference.role, bytes: reference.bytes, contentType: reference.contentType })), textOnly,
              progress: raw.progress,
            }, dependencies);
            await dependencies.storage.validate(generated.originalBytes, signal);
            await dependencies.storage.validate(generated.bytes, signal);
            bytes = generated.bytes; promptId = generated.promptId;
            const referenceRoles = raw.resolvedReferences?.map(reference => ({ key: reference.key, name: reference.name, role: reference.role }));
            imageMetadata = { imageWorkflow, model: generated.model, seed: generated.seed, steps: generated.steps, cfg: generated.cfg,
              sampler: generated.sampler, scheduler: generated.scheduler, ...(generated.segmentationModel ? { segmentationModel: generated.segmentationModel } : {}),
              processingStatus: 'complete', generationMs: generated.generationMs, transparent: transparentSprite,
              referenceRoles };
            if (transparentSprite) storedArtifacts = { originalBytes: generated.originalBytes, originalSource: {
              provider: 'comfyui', imageKind: 'image', prompt: input.prompt, model: generated.model, imageWorkflow,
              seed: generated.seed, steps: generated.steps, cfg: generated.cfg, sampler: generated.sampler, scheduler: generated.scheduler,
              attribution: 'Untouched source raster from local ComfyUI Krea2-Anime v2.0 INT4.', createdAt: new Date(now()).toISOString(),
              greenRemoved: false, referenceKeys: raw.referenceImages?.map(reference => reference.assetRef ?? reference.key), referenceRoles } };
          } else {
            const prompt = transparentSprite ? dependencies.buildGreenScreenPrompt(input.prompt) : input.prompt;
            const result = await generateComfyImage(profile, prompt, signal, dependencies);
            bytes = result.bytes; promptId = result.promptId;
            await dependencies.storage.validate(bytes, signal);
            if (transparentSprite) {
              storedArtifacts = { originalBytes: bytes };
              try { bytes = await dependencies.removeGreenBackground(bytes, signal);backgroundRemoved = true; }
              catch { signal.throwIfAborted(); throw new GenerationError('SPRITE_PROCESSING_FAILED', 'ComfyUI sprite background could not be removed. Use a solid bright green background in the workflow.', 503); }
            }
          }
        } else {
          const prompt = transparentSprite ? dependencies.buildGreenScreenPrompt(input.prompt) : input.prompt;
          bytes = await generateForgeNeoImage(profile, prompt, input.imageKind, signal, dependencies.fetch);
          await dependencies.storage.validate(bytes, signal);
          if (transparentSprite) {
            storedArtifacts = { originalBytes: bytes };
            try { bytes = await dependencies.removeGreenBackground(bytes, signal);backgroundRemoved = true; }
            catch { signal.throwIfAborted(); throw new GenerationError('SPRITE_PROCESSING_FAILED', 'Forge Neo sprite background could not be removed. Use a solid bright green background in the prompt.', 503); }
          }
        }
        signal.throwIfAborted();
        const source: GeneratedSource = { provider: selected, imageKind: input.imageKind, prompt: input.prompt, ...imageMetadata,
          ...(hasReferences ? { referenceMode: textOnly ? 'text' as const : 'visual' as const } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}), ...(promptId ? { promptId } : {}), ...(selected === 'forgeneo' && profile.model ? { model: profile.model } : {}),
          imageWorkflow: input.imageWorkflow ?? imageMetadata.imageWorkflow, contentRating: input.contentRating ?? 'sfw', transparent: transparentSprite,
          attribution: imageMetadata.imageWorkflow === 'krea' ? 'Generated locally with ComfyUI and Krea2-Anime v2.0 INT4.'
            : imageMetadata.model ? 'Generated locally with ComfyUI and the selected Anima checkpoint.'
            : selected === 'comfyui' ? 'Generated with the creator’s ComfyUI workflow.' : `Generated with Forge Neo${profile.model ? ` (${profile.model})` : ''}.`,
          greenRemoved: backgroundRemoved, ...(raw.referenceImages?.length ? { referenceKeys: raw.referenceImages.map(reference => reference.assetRef ?? reference.key) } : {}),
          createdAt: new Date(now()).toISOString() };
        return await dependencies.storage.save(userId, bytes, source, signal, storedArtifacts);
      } catch (error) {
        if (claimed && input.requestId) await dependencies.storage.failRequest?.(userId, input.requestId).catch(() => {});
        throw safeGenerationFailure(error, signal);
      }
      finally { active.delete(userId); }
    },
  };
}
