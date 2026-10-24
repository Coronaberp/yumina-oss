import assert from "node:assert/strict";
import test, { after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../../db/index.js";
import { createCodexImageService, selectStudioImageSource, checkStudioImageRequest } from "./codex-service.js";
import { env } from "../env.js";
import type { GeneratedStorage } from "./service.js";
import type { GeneratedAsset } from "./config.js";
import sharp from "sharp";
import { normalizeGeneratedRaster, commitGeneratedAsset } from "./asset-store.js";

after(async () => {
  assert.ok(db.$client instanceof PGlite);
  // Finish the isolated DB lifecycle before --test-force-exit bypasses beforeExit.
  await db.$client.close();
});

function setup(overrides: Partial<GeneratedStorage> = {}) {
  let calls = 0, saved: GeneratedAsset | undefined;
  const storage: GeneratedStorage = { preflight: async () => {}, validate: async () => {}, findRequest: async () => saved,
    claimRequest: async () => undefined, failRequest: async () => {}, save: async (_user, _bytes, source) => saved = { id: "asset", ref: "@asset:asset", filename: "codex.png", source }, ...overrides };
  const service = createCodexImageService({ storage, enabled: () => true, command: () => "test-codex", generate: async () => {
    calls++; return { bytes: Buffer.from("image"), model: "gpt-6.1-sol", reasoningEffort: "xhigh" };
  } });
  return { service, calls: () => calls };
}
test("Codex images save Sol/xhigh provenance and replay without generating twice", async () => {
  const { service, calls } = setup();
  const input = { prompt: "Gold star", imageKind: "image" as const, requestId: "once" };
  const first = await service.generate("user", input);
  assert.equal(first.source.provider, "codex");assert.equal(first.source.model, "gpt-6.1-sol");assert.equal(first.source.reasoningEffort, "xhigh");
  assert.equal(first.source.greenRemoved, false);
  assert.deepEqual(await service.generate("user", input), first);assert.equal(calls(), 1);
});
test("Codex storage availability preflight prevents provider calls when storage is unavailable", async () => {
  const { service, calls } = setup({ preflight: async () => { throw new Error("storage unavailable"); } });
  await assert.rejects(service.generate("user", { prompt: "Gold star", imageKind: "image" }), /storage unavailable/);
  assert.equal(calls(), 0);
});
test("shared image default is independent of the main agent and explicit providers are respected", () => {
  const state = { activeProvider: "codex", configs: { codex: { configured: true }, comfyui: { configured: false }, forgeneo: { configured: true } } } as const;
  assert.equal(selectStudioImageSource({}, state, false), "codex");
  assert.equal(selectStudioImageSource({ source: "forgeneo" }, state, false), "forgeneo");
  assert.equal(selectStudioImageSource({ source: "codex", model: "different-model" }, state, false), "codex");
});
test("Studio image confirmation fails closed when its request checker is unavailable", async t => {
  const previous = env.YUMINA_STUDIO_CODEX_ENABLED;
  t.after(() => { env.YUMINA_STUDIO_CODEX_ENABLED = previous; });
  env.YUMINA_STUDIO_CODEX_ENABLED = false;
  await assert.rejects(checkStudioImageRequest("NSFW image"), /could not be checked/);
});

test("four distinct Codex images for one creator start concurrently with independent cancellation", async () => {
  const calls: Array<{ signal: AbortSignal; finish: () => void }> = [];
  const storage: GeneratedStorage = { preflight: async () => {}, validate: async () => {}, findRequest: async () => undefined,
    claimRequest: async () => undefined, failRequest: async () => {}, save: async (_user, _bytes, source) => ({ id: source.requestId!, ref: `@asset:${source.requestId}`, filename: "image.png", source }) };
  const service = createCodexImageService({ storage, enabled: () => true, command: () => "test-codex", generate: async options => new Promise((resolve, reject) => {
    calls.push({ signal: options.signal!, finish: () => resolve({ bytes: Buffer.from("image"), model: "gpt-6.1-sol", reasoningEffort: "xhigh" }) });
    options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }) });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller, index) => service.generate("creator", { prompt: "Safe circle", imageKind: "image", requestId: `image-${index}`, signal: controller.signal }));
  const outcomes = Promise.allSettled(pending);
  await new Promise(resolve => setImmediate(resolve));assert.equal(calls.length, 4);
  await assert.rejects(service.generate("creator", { prompt: "Safe fifth", imageKind: "image", requestId: "fifth" }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "GENERATION_BUSY");
  controllers[1]!.abort(new Error("Cancel second image"));for (const [index, call] of calls.entries()) if (index !== 1) call.finish();
  const results = await outcomes;assert.equal(results[1]!.status, "rejected");assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  assert.equal(calls[0]!.signal.aborted, false);assert.equal(calls[2]!.signal.aborted, false);
});

test("four concurrent Codex completions all pass real raster validation and save without provider replay", async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 80, b: 160, alpha: 0 } } }).png().toBuffer();
  let providerCalls = 0;
  const saved: string[] = [];
  const storage: GeneratedStorage = { preflight: async () => {},
    validate: async (data, signal) => { await normalizeGeneratedRaster(data, signal); },
    save: async (owner, data, source, signal) => {
      const raster = await normalizeGeneratedRaster(data, signal, true);
      return commitGeneratedAsset(owner, raster.bytes, source, {
        write: async () => {}, register: async asset => { saved.push(asset.id); } }, signal);
    } };
  const service = createCodexImageService({ storage, enabled: () => true, command: () => "test-codex", generate: async () => {
    providerCalls++;return { bytes, model: "gpt-6.1-sol", reasoningEffort: "xhigh" };
  } });
  const outputs = await Promise.all(Array.from({ length: 4 }, (_, index) => service.generate("creator", {
    prompt: "Safe circle", imageKind: "sprite", requestId: `completion-${index}` })));
  assert.equal(providerCalls, 4);assert.equal(outputs.length, 4);assert.equal(new Set(saved).size, 4);
});

test("cancelling a raster waiting for a decode slot leaves peer images intact", async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 80, b: 160, alpha: 0 } } }).png().toBuffer();
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(controller => normalizeGeneratedRaster(bytes, controller.signal, true));
  const settled = Promise.allSettled(pending);
  controllers[2]!.abort(new Error("Cancel waiting image"));
  const results = await settled;assert.equal(results[2]!.status, "rejected");assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  assert.equal((await normalizeGeneratedRaster(bytes, new AbortController().signal, true)).width, 64);
});
