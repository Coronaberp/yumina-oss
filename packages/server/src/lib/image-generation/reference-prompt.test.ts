import assert from "node:assert/strict";
import test from "node:test";
import { createNsfwReferencePrompt } from "./reference-prompt.js";
import type { GenerateParams, LLMProvider, StreamChunk } from "../llm/types.js";

const input = { prompt: "Make an academy heroine", imageKind: "sprite" as const, contentRating: "nsfw" as const,
  referenceImages: [{ key: "owned", url: "owned", name: "Character" }],
  resolvedReferences: [{ key: "owned", name: "Character", role: "identity" as const, bytes: Buffer.from("reference bytes"), contentType: "image/png" }],
};
const provider = (generateStream: LLMProvider["generateStream"]) => ({ generateStream });

test("vision descriptions include owned image bytes and roles, then become a standalone text prompt", async () => {
  let request: GenerateParams | undefined;
  const prepare = createNsfwReferencePrompt({
    resolveProvider: async () => ({ model: "selected-vision-model", provider: provider(async function* (params) {
      request = params;
      yield { type: "text", content: "The adult heroine has cobalt hair, " };
      yield { type: "text", content: "gold eyes and a navy uniform." };
      yield { type: "done", content: "", stopReason: "end_turn" };
    }) }),
    loadReferences: async () => { throw new Error("References already resolved"); },
  });
  const prompt = await prepare("owner", input);
  assert.equal(prompt, "Make an academy heroine\n\nVisual reference descriptions (text only):\nThe adult heroine has cobalt hair, gold eyes and a navy uniform.");
  assert.equal(request?.model, "selected-vision-model");
  const message = request?.messages.find(message => message.role === "user");
  assert.ok(message && Array.isArray(message.content));
  assert.ok(message.content.some(part => part.type === "text" && part.text.includes("role: identity")));
  assert.ok(message.content.some(part => part.type === "image_url" && part.image_url.url === "data:image/png;base64,cmVmZXJlbmNlIGJ5dGVz"));
});

for (const [name, chunks] of [
  ["empty output", [{ type: "done", content: "", stopReason: "end_turn" }]],
  ["failed vision request", [{ type: "text", content: "partial" }, { type: "error", content: "endpoint failed" }]],
  ["truncated description", [{ type: "text", content: "partial" }, { type: "done", content: "", stopReason: "max_tokens" }]],
] as Array<[string, StreamChunk[]]>) test(`${name} does not fall back to reference-to-image generation`, async () => {
  const prepare = createNsfwReferencePrompt({
    resolveProvider: async () => ({ model: "vision", provider: provider(async function* () { yield* chunks; }) }),
    loadReferences: async () => input.resolvedReferences,
  });
  await assert.rejects(prepare("owner", input), /No image was generated/);
});

test("cancelling reference analysis stops before the vision request", async () => {
  const controller = new AbortController(); controller.abort(new Error("Cancelled"));
  const prepare = createNsfwReferencePrompt({ resolveProvider: async () => { throw new Error("No provider may be resolved"); }, loadReferences: async () => [] });
  await assert.rejects(prepare("owner", { ...input, signal: controller.signal }), /Cancelled/);
});
