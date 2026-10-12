import { env } from "../env.js";
import { generateCodexImage, checkCodexImageRequest } from "../llm/codex.js";
import { GenerationError, generationInput, type GenerationInput, type GeneratedAsset } from "./config.js";
import type { GeneratedStorage } from "./service.js";
import { combinedSignal } from "./transport.js";
import { loadStudioImageReferences } from "../studio-image-references.js";

export const codexImagesEnabled = () => env.YUMINA_EDITION === "local" && env.YUMINA_STUDIO_CODEX_ENABLED;
export const CODEX_IMAGE_LABEL = "GPT-6.1 Sol · xhigh";

/** Host default is independent of the main Studio agent profile. */
export function selectStudioImageSource(raw: Record<string, unknown>, state: { activeProvider: "codex" | "comfyui" | "forgeneo"; configs: Record<string, { configured: boolean }> }, platform: boolean) {
  if (raw.source === "codex" || raw.source === "comfyui" || raw.source === "forgeneo") return raw.source;
  if (raw.source === "openai") return "forgeneo";
  return state.configs[state.activeProvider]?.configured || !platform ? state.activeProvider : undefined;
}

export async function checkStudioImageRequest(prompt: string, signal?: AbortSignal) {
  if (!codexImagesEnabled()) throw new GenerationError("REQUEST_CHECK_UNAVAILABLE", "Image generation cannot start because the request could not be checked. The shared Codex image connection is unavailable.", 503);
  await checkCodexImageRequest({ prompt, signal, command: env.YUMINA_STUDIO_CODEX_BIN });
}

export function createCodexImageService(dependencies: { storage: GeneratedStorage; enabled(): boolean; command(): string; generate?: typeof generateCodexImage }) {
  const active = new Set<symbol>();
  const recent = new Map<string, number[]>();
  return {
    async generate(userId: string, raw: GenerationInput): Promise<GeneratedAsset> {
      const input = generationInput.omit({ provider: true }).parse(raw);
      if (input.transparent && input.imageKind !== 'sprite')
        throw new GenerationError('INVALID_TRANSPARENCY', 'Transparent background output is supported for character sprites. Keep scene backgrounds opaque.');
      const signal = combinedSignal(raw.signal, 600_000);
      signal.throwIfAborted();
      if (!dependencies.enabled()) throw new GenerationError("NOT_CONFIGURED", "The shared Codex image connection is unavailable.", 409);
      if (input.requestId) {
        const previous = await dependencies.storage.findRequest?.(userId, input.requestId, signal);
        if (previous) return previous;
      }
      if (active.size >= 4) throw new GenerationError("GENERATION_BUSY", "Four images are already drawing. Try again shortly.", 429);
      const now = Date.now();
      for (const [id, times] of recent) if (!times.some(time => now - time < 60_000)) recent.delete(id);
      const times = (recent.get(userId) ?? []).filter(time => now - time < 60_000);
      if (times.length >= 12) throw new GenerationError("RATE_LIMITED", "Generate at most twelve images per minute. Try again shortly.", 429);
      const worker = Symbol("Codex image session");
      active.add(worker);
      // Reserve admission before awaiting storage so concurrent requests don't
      // overwrite one another's count or share a cancellation slot.
      recent.set(userId, [...times, now]);
      let claimed = false;
      try {
        if (input.requestId && dependencies.storage.claimRequest) {
          const previous = await dependencies.storage.claimRequest(userId, input.requestId, signal);
          if (previous) return previous;
          claimed = true;
        }
        await dependencies.storage.preflight(userId, signal);
        signal.throwIfAborted();
        const references = await loadStudioImageReferences(userId, raw.referenceImages ?? [], signal, undefined, raw.worldId);
        const result = await (dependencies.generate ?? generateCodexImage)({ prompt: input.prompt, imageKind: input.imageKind, transparent: input.transparent === true,
          signal, command: dependencies.command(), referenceImages: references });
        await dependencies.storage.validate(result.bytes, signal);
        return await dependencies.storage.save(userId, result.bytes, {
          provider: "codex", imageKind: input.imageKind, imageWorkflow: "codex", contentRating: input.contentRating ?? "sfw", transparent: input.transparent === true,
          prompt: input.prompt, requestId: input.requestId,
          model: result.model, reasoningEffort: result.reasoningEffort, greenRemoved: false,
          attribution: "Generated through the shared Codex account using GPT-6.1 Sol with xhigh reasoning and its native image tool.",
          createdAt: new Date().toISOString(),
          ...(raw.referenceImages?.length ? { referenceKeys: raw.referenceImages.map(ref => ref.key) } : {}),
        }, signal);
      } catch (error) {
        if (claimed && input.requestId) await dependencies.storage.failRequest?.(userId, input.requestId).catch(() => {});
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally { active.delete(worker); }
    },
  };
}
