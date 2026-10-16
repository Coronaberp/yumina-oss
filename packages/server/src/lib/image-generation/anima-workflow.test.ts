import assert from "node:assert/strict";
import test from "node:test";
import { buildAnimaSpriteWorkflow, filterAnimaModels } from "./anima-workflow.js";
import * as animaPolicy from "./anima-workflow.js";

const installedModels = [
  "anima-base-v1.0.safetensors",
  "gemCollectionAnima_moonstone.safetensors",
  "other-model.safetensors",
  "anima-turbo-lora-v0.2.safetensors",
];

test("model catalog includes installed Anima checkpoints only and preserves user-selectable names", () => {
  assert.deepEqual(filterAnimaModels(installedModels), [
    "anima-base-v1.0.safetensors", "gemCollectionAnima_moonstone.safetensors",
  ]);
});

test("Anima model edits are accepted only for a queued request inside its preparation window", () => {
  const policy = (animaPolicy as unknown as { canChangeAnimaModel?: (job: { status: string; animaEnabled: boolean; preparationUntil?: number }, now: number) => boolean }).canChangeAnimaModel;
  assert.equal(typeof policy, "function");
  assert.equal(policy!({ status: "queued", animaEnabled: true, preparationUntil: 110 }, 100), true);
  assert.equal(policy!({ status: "running", animaEnabled: true, preparationUntil: 110 }, 100), false);
  assert.equal(policy!({ status: "queued", animaEnabled: true, preparationUntil: 90 }, 100), false);
  assert.equal(policy!({ status: "queued", animaEnabled: false, preparationUntil: 110 }, 100), false);
});

test("Anima workflow pairs local encoders and builds the 8-step sprite plus separate source/mask outputs", () => {
  const workflow = buildAnimaSpriteWorkflow({
    modelName: "gemCollectionAnima_moonstone.safetensors",
    imageKind: "sprite", transparent: true,
    prompt: "1girl, happy expression",
    chromaColor: "#00d8ff",
    seed: 47,
    references: [],
    availableModels: installedModels,
    sourcePrefix: "illumitest",
  });
  const nodes = Object.values(workflow) as Array<{ class_type: string; inputs: Record<string, unknown> }>;
  const byType = (type: string) => nodes.find(node => node.class_type === type);
  assert.equal(byType("UNETLoader")?.inputs.unet_name, "gemCollectionAnima_moonstone.safetensors");
  assert.equal(byType("CLIPLoader")?.inputs.clip_name, "gemCollectionAnima_moonstone_txt.safetensors");
  assert.equal(byType("VAELoader")?.inputs.vae_name, "qwen_image_vae.safetensors");
  const sampler = byType("KSampler")?.inputs;
  assert.equal(sampler?.steps, 8);
  assert.equal(sampler?.cfg, 1);
  assert.equal(sampler?.sampler_name, "er_sde");
  assert.equal(sampler?.scheduler, "simple");
  assert.equal(sampler?.seed, 47);
  assert.match(String(byType("CLIPTextEncode")?.inputs.text), /plain flat uniform bright solid #00d8ff background/i);
  assert.equal(byType("BiRefNetRMBG")?.inputs.model, "BiRefNet-portrait");
  assert.equal(byType("BiRefNetRMBG")?.inputs.invert_output, false);
  assert.equal(byType("SaveImage")?.inputs.filename_prefix, "illumitest-original");
  assert.ok(nodes.some(node => node.class_type === "SaveImage" && node.inputs.filename_prefix === "illumitest-mask"));
  assert.ok(nodes.some(node => node.class_type === "SaveImage" && node.inputs.filename_prefix === "illumitest-foreground"));
  assert.ok(nodes.some(node => node.class_type === "SaveImage" && node.inputs.filename_prefix === "illumitest-original"));
});

test("workflow groups references by role and refuses unlisted models and unsafe output names", () => {
  assert.throws(() => buildAnimaSpriteWorkflow({
    modelName: "../not-installed.safetensors", prompt: "sprite", chromaColor: "#ff00ff", seed: 1,
    references: [], availableModels: installedModels, sourcePrefix: "test",
  }), /installed Anima/);
  assert.throws(() => buildAnimaSpriteWorkflow({
    modelName: "anima-base-v1.0.safetensors", prompt: "sprite", chromaColor: "not-a-color", seed: 1,
    references: [], availableModels: installedModels, sourcePrefix: "../unsafe",
  }), /valid/);
  const workflow = buildAnimaSpriteWorkflow({
    modelName: "anima-base-v1.0.safetensors", prompt: "sprite", chromaColor: "#ff00ff", seed: 1,
    availableModels: installedModels, references: [
      { filename: "signynn.png", role: "identity" },
      { filename: "academy.png", role: "environment" },
      { filename: "style.png", role: "style" },
    ], sourcePrefix: "test",
  });
  const nodes = Object.values(workflow) as Array<{ class_type: string; inputs: Record<string, unknown> }>;
  assert.equal(nodes.filter(node => node.class_type === "AnimaInContextApply").length, 3);
  assert.equal(nodes.filter(node => node.class_type === "LoadImage").length, 3);
  assert.equal(nodes.filter(node => node.class_type === "InvertMask").length, 3);
  const prompt = String(nodes.find(node => node.class_type === "CLIPTextEncode")?.inputs.text);
  assert.match(prompt, /reference image 1 guides illustration style/i);
  assert.match(prompt, /reference image 2 is an environment sample/i);
  assert.match(prompt, /reference image 3 defines character identity/i);
  const applications = nodes.filter(node => node.class_type === "AnimaInContextApply").map(node => node.inputs.strength);
  assert.deepEqual(applications, [0.45, 0.35, 1.25], "role order maps to matching role-specific reference strengths");
  const referenceEncode = nodes.find(node => node.class_type === "AnimaRefEncode")?.inputs;
  assert.deepEqual(referenceEncode?.mask, ["23", 0]);
  assert.deepEqual(referenceEncode?.target_width, 832);
  assert.deepEqual(referenceEncode?.target_height, 1216);
});
