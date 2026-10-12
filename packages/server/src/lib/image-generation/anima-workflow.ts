import { ANIMA_BUILTIN_WORKFLOW, GenerationError, record } from "./config.js";
export { ANIMA_BUILTIN_WORKFLOW } from "./config.js";

export const DEFAULT_ANIMA_MODEL = "anima-base-v1.0.safetensors";
export const ANIMA_TURBO_LORA = "anima-turbo-lora-v0.2.safetensors";
export const ANIMA_IN_CONTEXT_LORA = "anima-incontext-character.safetensors";
export const ANIMA_OUTPUT_NODE_IDS = { original: "12", mask: "13", foreground: "14" } as const;
export type AnimaReferenceRole = "identity" | "environment" | "style" | "creator";
export type UploadedAnimaReference = { filename: string; role: AnimaReferenceRole; name?: string };
export type AnimaWorkflowOptions = {
  modelName: string; prompt: string; chromaColor: string; seed: number; references: UploadedAnimaReference[];
  imageKind?: "sprite" | "background" | "image";
  transparent?: boolean;
  availableModels: readonly unknown[]; availableLoras?: readonly unknown[]; sourcePrefix: string;
  steps?: number; cfg?: number; samplerName?: "er_sde" | "euler"; scheduler?: "simple" | "normal" | "sgm_uniform";
  width?: number; height?: number;
};
type ApiNode = { class_type: string; inputs: Record<string, unknown> };
export type AnimaApiWorkflow = Record<string, ApiNode>;
export function canChangeAnimaModel(job: { status: string; animaEnabled: boolean; preparationUntil?: number }, now = Date.now()) {
  return job.status === "queued" && job.animaEnabled && Number.isFinite(job.preparationUntil) && (job.preparationUntil ?? 0) > now;
}

function modelName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value : record(value) && typeof value.name === "string" ? value.name : undefined;
  return name && /^[\p{L}\p{N} _().+-]{1,180}\.safetensors$/iu.test(name) && !name.split(/[\\/]/).includes("..") ? name : undefined;
}

/** Names come from ComfyUI's live model catalog; arbitrary model text never reaches a loader node. */
export function filterAnimaModels(values: readonly unknown[]): string[] {
  return [...new Set(values.map(modelName).filter((name): name is string => !!name && /anima/i.test(name) && !/(?:lora|incontext)/i.test(name)))].sort((a, b) => a.localeCompare(b));
}
/** Local checkpoint names are the only capability metadata exposed by ComfyUI.
 * Unknown models stay SFW-only; the creator can still select every Anima file. */
export function animaModelSupportsNsfw(name: string): boolean {
  return /(?:nsfw|uncensored|unfiltered|porn|hentai|adult|erotic|lust|spicy)/i.test(name);
}
export function filterAnimaLoras(values: readonly unknown[]): string[] {
  return [...new Set(values.map(modelName).filter((name): name is string => !!name && /anima/i.test(name)))].sort((a, b) => a.localeCompare(b));
}
export function encoderForAnimaModel(name: string): string {
  if (/^gemCollectionAnima_(moonstone|sunstone)\.safetensors$/i.test(name)) return name.replace(/\.safetensors$/i, "_txt.safetensors");
  return "qwen_3_06b_base.safetensors";
}
function safeImageName(value: string) {
  if (!value || value.length > 255 || value.startsWith("/") || value.includes("\\") || /[\x00-\x1f]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new GenerationError("INVALID_REFERENCE", "ComfyUI returned an invalid uploaded reference filename.");
  }
  return value;
}
function node(type: string, inputs: Record<string, unknown>): ApiNode { return { class_type: type, inputs }; }
const roleOrder: readonly AnimaReferenceRole[] = ["style", "environment", "creator", "identity"];
const roleStrength: Record<AnimaReferenceRole, number> = { identity: 1.25, creator: 0.9, style: 0.45, environment: 0.35 };
const chromaLabels: Record<string, string> = {
  "#ff00ff": "electric magenta", "#00ff00": "lime green", "#00ffff": "bright cyan", "#ff7900": "vivid orange",
  "#174bff": "ultramarine blue", "#ffff00": "bright yellow", "#8e00ff": "violet purple", "#ff286e": "hot pink",
};

export function buildAnimaSpritePrompt(prompt: string, chromaColor: string, references: UploadedAnimaReference[], transparent = false) {
  const label = chromaLabels[chromaColor.toLowerCase()] ?? `bright solid ${chromaColor}`;
  const orderedReferences = roleOrder.flatMap(role => references.filter(reference => reference.role === role));
  const roleInstructions = orderedReferences.length ? ` Reference guidance: ${orderedReferences.map((reference, i) => {
    const name = reference.name ? ` (${reference.name.slice(0, 100)})` : "";
    const role = reference.role === "identity" ? `reference image ${i + 1}${name} defines character identity, hair, face, body shape and costume; preserve these`
      : reference.role === "style" ? `reference image ${i + 1}${name} guides illustration style and palette only`
        : reference.role === "environment" ? `reference image ${i + 1}${name} is an environment sample only; keep the sprite isolated and do not draw scenery`
          : `reference image ${i + 1}${name} is creator-provided visual guidance for the requested pose or content`;
    return role;
  }).join("; ")}. Reference images are injected in this same order with lower strength for style and environment guidance, and the strongest strength for character identity.` : "";
  if (transparent) return `single isolated character, visual novel character sprite, clean anime illustration, thigh-up framing, full visible silhouette, plain flat uniform ${label} background filling the whole image (${chromaColor}), character in front of the solid backdrop, no environment, no scenery, no cast shadows on the background; ${prompt.trim()}; keep the entire background one uniform ${label} color (${chromaColor}), no white background, no transparent background, no checkerboard, no text${roleInstructions}`;
  return `single visual-novel character illustration, clean anime illustration, thigh-up framing, full visible silhouette; ${prompt.trim()}; opaque background, no checkerboard, no text${roleInstructions}`;
}

export function buildAnimaBackgroundPrompt(prompt: string, references: UploadedAnimaReference[]) {
  const orderedReferences = roleOrder.flatMap(role => references.filter(reference => reference.role === role));
  const guidance = orderedReferences.length ? ` Reference guidance: ${orderedReferences.map((reference, i) => {
    const name = reference.name ? ` (${reference.name.slice(0, 100)})` : "";
    const role = reference.role === "environment" ? "defines the location and composition; preserve its architecture and layout"
      : reference.role === "style" ? "guides illustration style and palette only"
        : reference.role === "identity" ? "defines a character to preserve if one is requested"
          : "is creator-provided visual guidance";
    return `reference image ${i + 1}${name} ${role}`;
  }).join("; ")}. Apply visual references in the same order.` : "";
  return `visual novel background illustration, complete environment, coherent perspective and composition, no border, no text; ${prompt.trim()}${guidance}`;
}

export function buildAnimaSpriteWorkflow(options: AnimaWorkflowOptions): AnimaApiWorkflow {
  const models = filterAnimaModels(options.availableModels);
  if (!models.includes(options.modelName)) throw new GenerationError("ANIMA_MODEL_UNAVAILABLE", "Choose an installed Anima checkpoint from the configured ComfyUI container.");
  const loras = options.availableLoras ? filterAnimaLoras(options.availableLoras) : undefined;
  if (loras && !loras.includes(ANIMA_TURBO_LORA)) throw new GenerationError("ANIMA_TURBO_MISSING", "The local Anima Turbo LoRA is missing from ComfyUI.", 503);
  if (options.references.length > 5) throw new GenerationError("INVALID_REFERENCE", "Use at most five reference images.");
  const color = options.chromaColor;
  const imageKind = options.imageKind ?? "sprite";
  if ((imageKind === "sprite" && options.transparent === true && !/^#[0-9a-f]{6}$/i.test(color)) || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > Number.MAX_SAFE_INTEGER
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.sourcePrefix)) throw new GenerationError("INVALID_ANIMA_OPTIONS", "The Anima sprite settings are invalid.");
  const steps = options.steps ?? 8, cfg = options.cfg ?? 1, width = options.width ?? 832, height = options.height ?? 1216;
  if (!Number.isInteger(steps) || steps < 1 || steps > 20 || !Number.isFinite(cfg) || cfg < 0.5 || cfg > 8
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 512 || height < 512 || width > 1536 || height > 1536 || width % 8 || height % 8)
    throw new GenerationError("INVALID_ANIMA_OPTIONS", "Anima dimensions, steps or guidance are outside supported limits.");
  const workflow: AnimaApiWorkflow = {
    "1": node("UNETLoader", { unet_name: options.modelName, weight_dtype: "default" }),
    "2": node("CLIPLoader", { clip_name: encoderForAnimaModel(options.modelName), type: "stable_diffusion", device: "default" }),
    "3": node("VAELoader", { vae_name: "qwen_image_vae.safetensors" }),
    "4": node("LoraLoader", { model: ["1", 0], clip: ["2", 0], lora_name: ANIMA_TURBO_LORA, strength_model: 1, strength_clip: 0 }),
    "5": node("CLIPTextEncode", { clip: ["4", 1], text: imageKind === "sprite"
      ? buildAnimaSpritePrompt(options.prompt, color, options.references, options.transparent === true) : buildAnimaBackgroundPrompt(options.prompt, options.references) }),
    "6": node("CLIPTextEncode", { clip: ["4", 1], text: imageKind === "sprite"
      ? options.transparent === true
        ? "worst quality, low quality, blurry, jpeg artifacts, multiple people, extra limbs, cropped head, cropped hands, gradient background, plain white background, transparent background, checkerboard, scenery, background objects, text, watermark"
        : "worst quality, low quality, blurry, jpeg artifacts, multiple people, extra limbs, cropped head, cropped hands, checkerboard, text, watermark"
      : "worst quality, low quality, blurry, jpeg artifacts, duplicated horizon, broken perspective, text, watermark, border" }),
    "7": node("EmptyLatentImage", { width, height, batch_size: 1 }),
    "8": node("KSampler", { model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
      seed: options.seed, steps, cfg, sampler_name: options.samplerName ?? "er_sde", scheduler: options.scheduler ?? "simple", denoise: 1 }),
    "9": node("VAEDecode", { samples: ["8", 0], vae: ["3", 0] }),
    "12": node("SaveImage", { images: ["9", 0], filename_prefix: `${options.sourcePrefix}-original` }),
  };
  if (imageKind === "sprite" && options.transparent === true) {
    workflow["10"] = node("BiRefNetRMBG", { image: ["9", 0], model: "BiRefNet-portrait", sensitivity: 0.85, mask_blur: 0,
      mask_offset: 0, invert_output: false, refine_foreground: true, unload_model: false, background: "Alpha", background_color: "#ffffff" });
    workflow["11"] = node("MaskToImage", { mask: ["10", 1] });
    workflow["13"] = node("SaveImage", { images: ["11", 0], filename_prefix: `${options.sourcePrefix}-mask` });
    workflow["14"] = node("SaveImage", { images: ["10", 0], filename_prefix: `${options.sourcePrefix}-foreground` });
  }

  const referencesByRole = new Map<AnimaReferenceRole, UploadedAnimaReference[]>();
  for (const reference of options.references) {
    const grouped = referencesByRole.get(reference.role) ?? [];
    grouped.push({ ...reference, filename: safeImageName(reference.filename) });
    referencesByRole.set(reference.role, grouped);
  }
  let nextId = 20;
  let model: [string, number] = ["4", 0];
  let clip: [string, number] = ["4", 1];
  if (options.references.length) {
    if (loras && !loras.includes(ANIMA_IN_CONTEXT_LORA)) throw new GenerationError("ANIMA_REFERENCE_LORA_MISSING", "The local Anima character-reference LoRA is missing from ComfyUI.", 503);
    workflow[String(nextId)] = node("LoraLoader", { model, clip, lora_name: ANIMA_IN_CONTEXT_LORA, strength_model: 1, strength_clip: 0 });
    model = [String(nextId++), 0]; clip = [String(nextId - 1), 1];
    // Apply style/environment first and identity last so the canonical character carries the strongest guidance.
    // Prompt reference numbering follows this same ordering so each role maps to the right latent.
    for (const role of roleOrder) {
      const refs = referencesByRole.get(role);
      if (!refs?.length) continue;
      const encoded: Array<[string, number]> = [];
      for (const reference of refs) {
        const loadId = String(nextId++), encodeId = String(nextId++);
        const maskId = String(nextId++);
        workflow[loadId] = node("LoadImage", { image: reference.filename });
        // ComfyUI's LoadImage mask is inverse alpha (white means transparent).
        // Inverting it lets AnimaRefEncode composite transparent sprites onto white.
        workflow[maskId] = node("InvertMask", { mask: [loadId, 1] });
        workflow[encodeId] = node("AnimaRefEncode", { vae: ["3", 0], image: [loadId, 0], mask: [maskId, 0],
          target_width: width, target_height: height });
        encoded.push([encodeId, 0]);
      }
      let refLatent = encoded[0]!;
      for (let index = 1; index < encoded.length; index++) {
        const mergeId = String(nextId++);
        workflow[mergeId] = node("AnimaRefLatentBatch", { ref_latent_1: refLatent, ref_latent_2: encoded[index]!, fit_mode: "pad" });
        refLatent = [mergeId, 0];
      }
      const applyId = String(nextId++);
      workflow[applyId] = node("AnimaInContextApply", { model, ref_latent: refLatent, strength: roleStrength[role], start_percent: 0,
        end_percent: 1, cond_only: true, fit_mode: "pad" });
      model = [applyId, 0];
    }
  }
  workflow["8"]!.inputs.model = model;
  workflow["5"]!.inputs.clip = clip;
  workflow["6"]!.inputs.clip = clip;
  return workflow;
}
