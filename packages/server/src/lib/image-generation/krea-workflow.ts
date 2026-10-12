import { GenerationError } from "./config.js";

export const KREA_MODEL = "Krea2-Anime-v2.0-INT4.safetensors";
export const KREA_CLIP = "qwen3vl_4b_bf16.safetensors";
export const KREA_VAE = "qwen_image_vae.safetensors";
export const KREA_OUTPUT_NODE_IDS = { original: "11", sprite: "12" } as const;

export type KreaReference = { filename: string; role: "identity" | "environment" | "style" | "creator"; name?: string };
export type KreaWorkflowOptions = {
  prompt: string;
  imageKind: "sprite" | "background" | "image";
  transparent?: boolean;
  references: KreaReference[];
  seed: number;
  steps?: number;
  cfg?: number;
  sourcePrefix: string;
  availableModels: readonly unknown[];
};
type ApiNode = { class_type: string; inputs: Record<string, unknown> };
export type KreaApiWorkflow = Record<string, ApiNode>;

function installedName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string"
    ? (value as { name: string }).name : undefined;
  return name && /^[\p{L}\p{N} _().+-]{1,180}\.safetensors$/iu.test(name) ? name : undefined;
}
function node(class_type: string, inputs: Record<string, unknown>): ApiNode { return { class_type, inputs }; }
function safeFilename(filename: string) {
  if (!filename || filename.length > 255 || filename.startsWith("/") || filename.includes("\\") || /[\x00-\x1f]/.test(filename)
    || filename.split("/").some(part => !part || part === "." || part === ".."))
    throw new GenerationError("INVALID_REFERENCE", "ComfyUI returned an invalid uploaded reference filename.");
  return filename;
}

function referencePrompt(references: KreaReference[]) {
  if (!references.length) return "";
  const descriptions = references.map((reference, index) => {
    const identity = reference.role === "identity";
    const role = identity ? "canonical character identity; preserve face, hair, eyes, outfit, accessories and proportions"
      : reference.role === "environment" ? "environment and composition guidance; do not copy people"
      : reference.role === "style" ? "visual style and palette guidance"
      : "creator-provided visual guidance";
    return `Picture ${index + 1}${reference.name ? ` (${reference.name})` : ""} is the ${role}`;
  });
  return ` ${descriptions.join(". ")}. Keep the character or scene recognizable while making only the requested changes.`;
}

/** API-format Krea2-Anime v2.0 INT4 graph matching the local ComfyUI node contract. */
export function buildKreaReferenceWorkflow(options: KreaWorkflowOptions): KreaApiWorkflow {
  if (!options.availableModels.map(installedName).includes(KREA_MODEL))
    throw new GenerationError("KREA_MODEL_UNAVAILABLE", "The configured local Krea2-Anime v2.0 INT4 model is not installed in ComfyUI.", 503);
  if (options.references.length > 4) throw new GenerationError("INVALID_REFERENCE", "Krea accepts at most four project references.");
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > Number.MAX_SAFE_INTEGER)
    throw new GenerationError("INVALID_KREA_OPTIONS", "The Krea seed is invalid.");
  const steps = options.steps ?? 8, cfg = options.cfg ?? 1;
  if (!Number.isInteger(steps) || steps < 1 || steps > 20 || !Number.isFinite(cfg) || cfg < 0.5 || cfg > 8
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.sourcePrefix))
    throw new GenerationError("INVALID_KREA_OPTIONS", "The Krea settings are outside supported limits.");
  let prompt = options.prompt.trim();
  if (options.imageKind === "sprite") prompt = `single visual-novel character sprite, thigh-up framing, entire silhouette visible, polished anime illustration, plain white background, no scenery, no text. ${prompt}`;
  else if (options.imageKind === "background") prompt = `Complete visual-novel background illustration, no frame, no text. ${prompt}`;
  prompt += referencePrompt(options.references);

  const workflow: KreaApiWorkflow = {
    "1": node("UNETLoader", { unet_name: KREA_MODEL, weight_dtype: "default" }),
    "2": node("CLIPLoader", { clip_name: KREA_CLIP, type: "krea2", device: "cpu" }),
    "3": node("VAELoader", { vae_name: KREA_VAE }),
    "5": node("TextEncodeKrea2Reference", { clip: ["2", 0], prompt }),
    "6": node("ConditioningZeroOut", { conditioning: ["5", 0] }),
    "7": node("EmptyLatentImage", { width: 832, height: 1216, batch_size: 1 }),
    "8": node("KSampler", { model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
      seed: options.seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1 }),
    "9": node("VAEDecode", { samples: ["8", 0], vae: ["3", 0] }),
  };
  const encode = workflow["5"]!.inputs;
  for (let index = 0; index < options.references.length; index++) {
    const imageId = String(20 + index * 2), maskId = String(21 + index * 2), reference = options.references[index]!;
    workflow[imageId] = node("LoadImage", { image: safeFilename(reference.filename) });
    workflow[maskId] = node("InvertMask", { mask: [imageId, 1] });
    const slot = index + 1;
    encode[`image${slot}`] = [imageId, 0];
    encode[`image${slot}_detail`] = reference.role === "identity" ? "max" : "high";
    encode[`image${slot}_mask`] = [maskId, 0];
  }
  workflow[KREA_OUTPUT_NODE_IDS.original] = node("SaveImage", { images: ["9", 0], filename_prefix: `${options.sourcePrefix}-original` });
  if (options.imageKind === "sprite" && options.transparent === true) {
    workflow["10"] = node("BiRefNetRMBG", { image: ["9", 0], model: "BiRefNet-portrait", sensitivity: 1,
      mask_blur: 0, mask_offset: 0, invert_output: false, refine_foreground: false, unload_model: true,
      background: "Alpha", background_color: "#222222" });
    workflow[KREA_OUTPUT_NODE_IDS.sprite] = node("SaveImage", { images: ["10", 0], filename_prefix: `${options.sourcePrefix}-sprite` });
  }
  return workflow;
}
