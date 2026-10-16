import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ANIMA_BUILTIN_WORKFLOW, defaultGenerationConfig, type GenerationInput } from "./config.js";
import { createImageGenerationService } from "./service.js";
import { KREA_MODEL } from "./krea-workflow.js";

for (const imageWorkflow of ["krea", "anima"] as const) for (const imageKind of ["sprite", "background"] as const) {
  test(`NSFW ${imageWorkflow} ${imageKind} uses a vision description and sends no image references to ComfyUI`, async () => {
    const pixels = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    const model = "anima-adult.safetensors";
    const state = defaultGenerationConfig();
    state.configs.comfyui = { ...state.configs.comfyui, enabled: true, workflow: ANIMA_BUILTIN_WORKFLOW };
    let graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
    const paths: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === "/models/diffusion_models") return Response.json([KREA_MODEL, model]);
      if (path === "/models/loras") return Response.json(["anima-turbo-lora-v0.2.safetensors", "anima-incontext-character.safetensors"]);
      if (path.startsWith("/object_info/")) return Response.json({ TextEncodeKrea2Reference: {}, CLIPTextEncode: {} });
      if (path === "/upload/image") return Response.json({ name: "reference.png", subfolder: "" });
      if (path === "/prompt") { graph = JSON.parse(String(init?.body)).prompt; return Response.json({ prompt_id: "image" }); }
      if (path === "/history/image") return Response.json({ image: { status: { completed: true, status_str: "success" }, outputs: {
        "11": { images: [{ filename: "image.png", subfolder: "", type: "output" }] },
        "12": { images: [{ filename: "image.png", subfolder: "", type: "output" }] },
      } } });
      if (path === "/view") return new Response(new Uint8Array(pixels));
      throw new Error(`Unexpected provider path ${path}`);
    };
    const description = imageKind === "sprite" ? "Adult heroine with cobalt hair, gold eyes and a navy academy uniform."
      : "A stone academy hall with arched windows, violet banners and warm evening light.";
    const dependencies = {
      repository: { get: async () => state, update: async () => state, clear: async () => state },
      storage: { preflight: async () => {}, validate: async () => {}, save: async (_user: string, _bytes: Buffer, source: Parameters<Parameters<typeof createImageGenerationService>[0]["storage"]["save"]>[2]) => ({ id: "saved", ref: "@asset:saved", filename: "image.png", source }) },
      fetch: fetcher, pollDelayMs: 1, webSocket: null,
      buildGreenScreenPrompt: (prompt: string) => prompt, removeGreenBackground: async (bytes: Buffer) => bytes,
      prepareNsfwPrompt: async (_user: string, input: GenerationInput) => `${input.prompt}\n\nVisual reference description: ${description}`,
    };
    const service = createImageGenerationService(dependencies);
    const result = await service.generate("owner", { provider: "comfyui", imageWorkflow, imageKind, contentRating: "nsfw", prompt: "Create the requested artwork.",
      animaModel: model, seed: 42, referenceImages: [{ key: "@asset:reference", url: "@asset:reference", assetRef: "@asset:reference", name: "Reference" }],
      resolvedReferences: [{ key: "@asset:reference", name: "Reference", role: imageKind === "sprite" ? "identity" : "environment", bytes: pixels, contentType: "image/png" }],
    });
    assert.ok(!paths.includes("/upload/image"), "NSFW references must not be uploaded to the image generator");
    assert.ok(!Object.values(graph).some(node => /LoadImage|Reference|AnimaInContext/.test(node.class_type)), "NSFW workflows must contain no reference conditioning nodes");
    const text = Object.values(graph).filter(node => node.class_type === "CLIPTextEncode").map(node => String(node.inputs.text)).join("\n");
    assert.ok(text.includes(description), "the actual generator prompt must contain the vision model's reference description");
    assert.equal(result.source.referenceMode, "text");
  });
}

test("an NSFW reference request without a vision description fails before any image generation", async () => {
  const state = defaultGenerationConfig();
  state.configs.comfyui = { ...state.configs.comfyui, enabled: true, workflow: ANIMA_BUILTIN_WORKFLOW };
  let providerCalls = 0;
  const service = createImageGenerationService({
    repository: { get: async () => state, update: async () => state, clear: async () => state },
    storage: { preflight: async () => {}, validate: async () => {}, save: async () => { throw new Error("No image may be saved"); } },
    fetch: async () => { providerCalls++; throw new Error("No image generation may start"); },
    buildGreenScreenPrompt: prompt => prompt, removeGreenBackground: async bytes => bytes,
  });
  await assert.rejects(service.generate("owner", { provider: "comfyui", imageWorkflow: "krea", contentRating: "nsfw", imageKind: "sprite", prompt: "Read the reference",
    referenceImages: [{ key: "ref", url: "ref", name: "Reference" }],
  }), /vision/i);
  assert.equal(providerCalls, 0);
});
