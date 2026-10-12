import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ANIMA_BUILTIN_WORKFLOW, ANIMA_OUTPUT_NODE_IDS, DEFAULT_ANIMA_MODEL } from "./anima-workflow.js";
import { defaultGenerationConfig, GenerationError } from "./config.js";
import { combinedSignal } from "./transport.js";
import * as comfy from "./comfyui.js";

type Reference = { name: string; role: "identity" | "environment" | "style" | "creator"; bytes: Buffer; contentType?: string };
type Options = { animaModel: string; chromaColor: string; seed?: number; references?: Reference[]; progress?: (progress: { phase: string; percent?: number }) => void };
type Deps = { fetch: typeof fetch; pollDelayMs?: number };
const generate = (comfy as unknown as { generateComfyAnimaImage?: (profile: ReturnType<typeof defaultGenerationConfig>["configs"]["comfyui"], prompt: string, signal: AbortSignal, options: Options, deps: Deps) => Promise<Record<string, unknown>> }).generateComfyAnimaImage;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("built-in Anima API uploads owned references, returns original and BiRefNet mask, and reports metadata", async () => {
  assert.equal(typeof generate, "function");
  const original = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 240, g: 0, b: 220, alpha: 1 } } }).png().toBuffer();
  const matte = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  const paths: string[] = [], updates: Array<{ phase: string; percent?: number }> = [];
  let promptGraph: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
  const fetcher: typeof globalThis.fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname === "/models/diffusion_models") return json(["anima-base-v1.0.safetensors", "not-anima.safetensors"]);
    if (url.pathname === "/models/loras") return json(["anima-turbo-lora-v0.2.safetensors", "anima-incontext-character.safetensors"]);
    if (url.pathname === "/upload/image") {
      assert.ok(init?.body instanceof FormData);
      const uploaded = (init!.body as FormData).get("image") as File;
      assert.match(uploaded.name, /^illumi-reference-[0-9a-f-]+-1\.png$/);
      assert.equal((await uploaded.arrayBuffer()).byteLength, 3);
      return json({ name: uploaded.name, subfolder: "", type: "input" });
    }
    if (url.pathname === "/prompt") {
      const request = JSON.parse(String(init?.body)) as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>; client_id: string };
      promptGraph = request.prompt;
      assert.equal(request.prompt["1"]?.inputs.unet_name, DEFAULT_ANIMA_MODEL);
      assert.equal(request.prompt["8"]?.inputs.steps, 8);
      assert.equal(request.prompt["20"]?.class_type, "LoraLoader");
      assert.ok(Object.values(request.prompt).some(node => node.class_type === "LoadImage" && String(node.inputs.image).startsWith("illumi-reference-")));
      assert.match(String(request.prompt["5"]?.inputs.text), /#00d8ff/i);
      return json({ prompt_id: "anima-job" });
    }
    if (url.pathname === "/history/anima-job") return json({ "anima-job": { status: { completed: true, status_str: "success" }, outputs: {
      [ANIMA_OUTPUT_NODE_IDS.original]: { images: [{ filename: "source.png", subfolder: "", type: "output" }] },
      [ANIMA_OUTPUT_NODE_IDS.mask]: { images: [{ filename: "mask.png", subfolder: "", type: "output" }] },
      [ANIMA_OUTPUT_NODE_IDS.foreground]: { images: [{ filename: "foreground.png", subfolder: "", type: "output" }] },
    } } });
    if (url.pathname === "/view") return new Response(url.searchParams.get("filename") === "mask.png" ? matte : original);
    throw new Error(`Unexpected ComfyUI path ${url.pathname}`);
  };
  const profile = { ...defaultGenerationConfig().configs.comfyui, enabled: true, workflow: ANIMA_BUILTIN_WORKFLOW };
  const result = await generate!(profile, "cheerful student", combinedSignal(undefined, 20_000), {
    animaModel: DEFAULT_ANIMA_MODEL, chromaColor: "#00d8ff", seed: 71,
    references: [{ name: "Signynn", role: "identity", bytes: Buffer.from("ref") }],
    progress: value => updates.push(value),
  }, { fetch: fetcher, pollDelayMs: 1 });
  assert.equal((result.originalBytes as Buffer).byteLength, original.byteLength);
  assert.equal((result.segmentationMaskBytes as Buffer).byteLength, matte.byteLength);
  assert.equal((result.refinedForegroundBytes as Buffer).byteLength, original.byteLength);
  assert.equal(result.seed, 71);
  assert.equal(result.model, DEFAULT_ANIMA_MODEL);
  assert.ok(paths.includes("/upload/image") && paths.includes("/prompt") && paths.includes("/history/anima-job"));
  assert.ok(updates.some(item => item.phase === "queued"));
  assert.ok(promptGraph);
});

test("built-in mode rejects a removed model instead of running a fallback model", async () => {
  assert.equal(typeof generate, "function");
  let submitted = false;
  const fetcher: typeof globalThis.fetch = async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path === "/models/diffusion_models") return json(["anima-base-v1.0.safetensors"]);
    if (path === "/models/loras") return json(["anima-turbo-lora-v0.2.safetensors"]);
    if (path === "/prompt") submitted = true;
    return json({});
  };
  const profile = { ...defaultGenerationConfig().configs.comfyui, enabled: true, workflow: ANIMA_BUILTIN_WORKFLOW };
  await assert.rejects(generate!(profile, "sprite", combinedSignal(undefined, 3000), {
    animaModel: "deleted-anima-model.safetensors", chromaColor: "#ff00ff", seed: 1, references: [],
  }, { fetch: fetcher, pollDelayMs: 1 }), (error: unknown) => error instanceof GenerationError && error.code === "ANIMA_MODEL_UNAVAILABLE");
  assert.equal(submitted, false);
});
