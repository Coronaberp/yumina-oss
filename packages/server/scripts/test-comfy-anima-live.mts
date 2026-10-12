import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createImageGenerationService, type GeneratedStorage } from "../src/lib/image-generation/service.js";
import { ANIMA_BUILTIN_WORKFLOW, defaultGenerationConfig, type GenerationCredentials, type GeneratedAsset } from "../src/lib/image-generation/config.js";
import { getComfyAnimaModels } from "../src/lib/image-generation/comfyui.js";
import { normalizeGeneratedRaster } from "../src/lib/image-generation/asset-store.js";

const args = new Map(process.argv.slice(2).filter(value => value.startsWith("--")).map(value => {
  const [key, ...rest] = value.slice(2).split("=");return [key!, rest.join("=") || "true"] as const;
}));
const outputDirectory = args.get("out") ?? `/tmp/yumina-comfy-anima-${Date.now()}`;
const baseUrl = args.get("url") ?? "http://127.0.0.1:8188";
const signal = AbortSignal.timeout(45 * 60_000);
const state: GenerationCredentials = defaultGenerationConfig();
state.configs.comfyui = { ...state.configs.comfyui, enabled: true, baseUrl, workflow: ANIMA_BUILTIN_WORKFLOW };
const profile = state.configs.comfyui;
const catalog = await getComfyAnimaModels(profile, signal);
const explicitModels = args.get("models")?.split(",").map(name => name.trim()).filter(Boolean);
const models = explicitModels?.length ? explicitModels : args.get("all") === "true" ? catalog.models : [catalog.recommendedModel];
for (const model of models) if (!catalog.models.includes(model)) throw new Error(`Not installed as an Anima checkpoint: ${model}`);
await mkdir(outputDirectory, { recursive: true });
const sampler = args.get("sampler") ?? "er_sde";
if (sampler !== "er_sde" && sampler !== "euler") throw new Error("--sampler must be er_sde or euler");
const referencePath = args.get("reference");
const referenceBytes = referencePath ? await readFile(referencePath) : undefined;
const referenceRole = args.get("reference-role") ?? "identity";
if (!["identity", "environment", "style", "creator"].includes(referenceRole)) throw new Error("Invalid --reference-role");
const expressions = args.get("expressions")?.split(",").map(value => value.trim()).filter(Boolean);
const promptOverride = args.get("prompt");
const repository = {
  async get() { return structuredClone(state); },
  async update() { return state; },
  async clear() { return state; },
};
const storage: GeneratedStorage = {
  async preflight(_userId, requestSignal) { requestSignal.throwIfAborted(); },
  async validate(bytes, requestSignal) { await normalizeGeneratedRaster(bytes, requestSignal); },
  async save(_userId, bytes, source, requestSignal, artifacts) {
    requestSignal.throwIfAborted();
    const slug = String(source.model ?? "anima").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    const basename = `${slug}-${String(source.seed ?? 0)}`;
    const finalPath = join(outputDirectory, `${basename}-transparent.png`);
    await writeFile(finalPath, bytes);
    if (artifacts?.originalBytes) await writeFile(join(outputDirectory, `${basename}-original.png`), artifacts.originalBytes);
    const asset: GeneratedAsset = { id: basename, ref: `@asset:${basename}`, filename: `${basename}-transparent.png`, source };
    return asset;
  },
};
const gpu = { peakUsedBytes: 0, samples: 0 };
const monitor = setInterval(() => {
  void fetch(new URL("/system_stats", baseUrl), { signal: AbortSignal.timeout(2_000) }).then(response => response.json()).then((value: any) => {
    const device = value?.devices?.find((item: any) => item.type === "cuda") ?? value?.devices?.[0];
    if (Number.isFinite(device?.vram_total) && Number.isFinite(device?.vram_free)) gpu.peakUsedBytes = Math.max(gpu.peakUsedBytes, device.vram_total - device.vram_free);
    gpu.samples++;
  }).catch(() => {});
}, 500);
monitor.unref();
const engine = createImageGenerationService({ repository, storage, buildGreenScreenPrompt: prompt => prompt,
  removeGreenBackground: async bytes => bytes, timeoutMs: 45 * 60_000 });
const defaultPrompt = "solo, one young adult woman, anime visual novel character sprite, vivid red long twin-tail hair with fine individual strands and small star clips, large teal eyes, bright lime-green academy jacket with ivory trim, black skirt, friendly neutral expression, arms gently held away from torso with a clear visible gap, standing, thigh-up framing, elegant clean anime line art, plain isolated figure, no scenery, wholesome, fully clothed";
const seed = Number(args.get("seed") ?? 846217);
const summary: Array<Record<string, unknown>> = [];
const jobs = models.flatMap(model => (expressions?.length ? expressions : [undefined]).map(expression => ({ model, expression })));
for (const [index, job] of jobs.entries()) {
  signal.throwIfAborted();
  const prompt = [promptOverride ?? defaultPrompt, job.expression ? `${job.expression} expression, ${job.expression} pose` : ""].filter(Boolean).join(", ");
  const requestId = `benchmark-${index}-${job.model.replace(/[^a-z0-9]/gi, "-")}${job.expression ? `-${job.expression}` : ""}`;
  const jobSeed = seed + (expressions?.length ? index : 0);
  const startedAt = Date.now();
  const referenceKey = referencePath ? `@asset:local-reference-${index}` : undefined;
  let asset: GeneratedAsset;
  try { asset = await engine.generate(`local-anima-benchmark-${index}`, { provider: "comfyui", imageKind: "sprite", prompt,
    animaModel: job.model, seed: jobSeed, steps: 8, requestId, samplerName: sampler,
    ...(referenceBytes && referenceKey ? {
      referenceImages: [{ key: referenceKey, url: referencePath!, assetRef: referenceKey, name: "canonical test reference", role: referenceRole as any, origin: "automatic" as const }],
      resolvedReferences: [{ key: referenceKey, name: "canonical test reference", role: referenceRole as any, bytes: referenceBytes, contentType: "image/png" }],
    } : {}) } as any); }
  catch (error) {
    const failure = { model: job.model, expression: job.expression, seed: jobSeed,
      error: error instanceof Error ? error.message.slice(0, 300) : "Generation failed." };
    summary.push(failure);
    console.log(JSON.stringify({ completed: index + 1, total: jobs.length, ...failure }));
    continue;
  }
  const elapsedMs = Date.now() - startedAt;
  const baseName = asset.filename.replace(/-transparent\.png$/i, "");
  const basename = `${baseName}${job.expression ? `-${job.expression}` : ""}`;
  const spritePath = join(outputDirectory, asset.filename);
  const metadata = await sharp(spritePath).metadata();
  const { data: rgba, info } = await sharp(spritePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let alphaOpaque = 0, alphaTransparent = 0;
  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    const alpha = rgba[pixel * 4 + 3]!;
    if (alpha >= 250) alphaOpaque++;
    if (alpha < 8) alphaTransparent++;
  }
  const qa = join(outputDirectory, "qa", basename);
  await mkdir(qa, { recursive: true });
  for (const [name, background] of [["black", "#000000"], ["white", "#ffffff"], ["gray", "#777777"]] as const) {
    await sharp({ create: { width: info.width, height: info.height, channels: 4, background } })
      .composite([{ input: spritePath }]).png().toFile(join(qa, `${name}.png`));
  }
  const checkerSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><defs><pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="32" height="32" fill="#eee"/><path d="M0 0h16v16H0zM16 16h16v16H16z" fill="#bbb"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`);
  await sharp(checkerSvg).composite([{ input: spritePath }]).png().toFile(join(qa, "checkerboard.png"));
  const result = { model: job.model, expression: job.expression, seed: asset.source.seed, steps: asset.source.steps, cfg: asset.source.cfg,
    sampler: asset.source.sampler, scheduler: asset.source.scheduler, loras: asset.source.loras, chromaColor: asset.source.chromaColor,
    actualBackgroundColor: asset.source.actualBackgroundColor, backgroundMismatch: asset.source.backgroundMismatch,
    requestedToActualDeltaE: asset.source.requestedToActualDeltaE,
    generationMs: asset.source.generationMs, processingMs: asset.source.processingMs, elapsedMs,
    width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha, alphaOpaqueRatio: alphaOpaque / (info.width * info.height),
    alphaTransparentRatio: alphaTransparent / (info.width * info.height), foregroundCoverage: asset.source.foregroundCoverage,
    transparentCorners: asset.source.transparentCorners, residualBackgroundRatio: asset.source.residualBackgroundRatio,
    detachedForegroundRatio: asset.source.detachedForegroundRatio,
    interiorChromaPixelsRemoved: asset.source.interiorChromaPixelsRemoved, reviewRequired: asset.source.reviewRequired,
    reviewReasons: asset.source.reviewReasons, filename: asset.filename, reference: referencePath, qaDirectory: qa };
  summary.push(result);
  console.log(JSON.stringify({ completed: index + 1, total: jobs.length, ...result }));
}
clearInterval(monitor);
const durations = summary.map(record => Number(record.elapsedMs)).filter(Number.isFinite);
await writeFile(join(outputDirectory, "benchmark.json"), JSON.stringify({ baseUrl, models, sampler, seed,
  catalog: { modelCount: catalog.models.length, recommendedModel: catalog.recommendedModel }, gpu: {
  peakUsedGiBObserved: Number((gpu.peakUsedBytes / 1024 ** 3).toFixed(2)), samples: gpu.samples,
}, averageRuntimeSeconds: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000).toFixed(2)) : null,
results: summary }, null, 2));
console.log(JSON.stringify({ done: true, outputDirectory, models: summary.length,
  averageRuntimeSeconds: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000).toFixed(2)) : null,
  peakUsedGiBObserved: Number((gpu.peakUsedBytes / 1024 ** 3).toFixed(2)), vramSamples: gpu.samples }));
