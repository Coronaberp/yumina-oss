import test, { after } from "node:test";
import assert from "node:assert/strict";
import { STUDIO_TOOLS, WRITE_TOOL_NAMES } from "./tools.js";

test("native card-media tool advertises independent owned references and bounded framing", () => {
  const tool = STUDIO_TOOLS.find(tool => tool.function.name === "write_world_media");
  assert.ok(tool, "native card portrait/banner changes need an actual function-calling tool");
  assert.ok(WRITE_TOOL_NAMES.has("write_world_media"));
  const schema = tool.function.parameters as { additionalProperties?: boolean; minProperties?: number; properties: Record<string, unknown> };
  assert.equal(schema.additionalProperties, false); assert.equal(schema.minProperties, 1);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["portraitAssetRef", "bannerAssetRef", "coverCrop", "bannerCrop"].sort());
  assert.match(tool.function.description, /portrait.*banner/i);
  assert.match(JSON.stringify(STUDIO_TOOLS.find(tool => tool.function.name === "read_entities")), /world-media/);
});

import { readFileSync } from "node:fs";
import type { WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, executeReadEntities, toolCallsToSchemaChanges } from "./tool-executor.js";
import { parseWorldMediaOperation, applyWorldMediaOperation, readWorldMedia } from "./world-media-tools.js";
import { resolveContext } from "./context-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";
after(async () => {
  const { db } = await import("../../db/index.js");
  if ("close" in db.$client && !db.$client.closed) await db.$client.close();
});
const portrait = "@asset:11111111-1111-4111-8111-111111111111", banner = "@asset:22222222-2222-4222-8222-222222222222";
const coverCrop = { x: 2, y: -3, zoom: 1.2, fit: "cover" as const }, bannerCrop = { x: 0, y: 4, zoom: 1, fit: "contain" as const };
function world(): WorldDefinition {
  return { id: "fixture-card", version: "21.0.0", name: "Native card media", description: "", author: "Author", avatar: "deprecated-avatar.png",
    coverCrop, galleryCoverCrop: { ...coverCrop, x: 5 }, bannerImageUrl: banner, bannerCrop,
    entries: [], variables: [], rules: [], components: [], customUI: [], audioTracks: [], settings: { playerName: "Player" },
    rootComponent: { id: "root", name: "Custom", entryFile: "index.tsx", updatedAt: "before", files: { "index.tsx": "// CUSTOM SOURCE\nexport default function App(){return null}" } },
    customData: { source: "PRESERVE PRIVATE CUSTOM SOURCE" } } as WorldDefinition;
}
function call(args: unknown) { return { id: "media-write", function: { name: "write_world_media", arguments: JSON.stringify(args) } }; }

test("native media parser rejects unknown keys, malformed refs and out-of-bounds framing", () => {
  const invalid = [undefined, null, [], {}, { avatar: portrait }, { portraitAssetRef: "" }, { bannerAssetRef: "@asset:wrong" },
    { bannerAssetRef: "https://example.test/banner.png" }, { portraitAssetRef: "/tmp/portrait.png" }, { portraitAssetRef: 3 },
    { coverCrop: [] }, { coverCrop: { x: "1" } }, { coverCrop: { x: 46 } }, { bannerCrop: { y: -46 } },
    { bannerCrop: { zoom: 0 } }, { coverCrop: { zoom: 3.1 } }, { bannerCrop: { fit: "stretch" } }, { bannerCrop: { secret: "unknown" } },
    { bannerAssetRef: banner, settings: { playerName: "Changed" } }];
  for (const value of invalid) assert.throws(() => parseWorldMediaOperation(value), Error, JSON.stringify(value));
  assert.throws(() => parseWorldMediaOperation({ coverCrop: { zoom: Infinity } }));
  assert.throws(() => parseWorldMediaOperation({ bannerCrop: { x: NaN } }));
  assert.deepEqual(parseWorldMediaOperation({ portraitAssetRef: portrait, bannerAssetRef: null, coverCrop, bannerCrop: null }),
    { portraitAssetRef: portrait, bannerAssetRef: null, coverCrop, bannerCrop: null });
});

test("native writes enter the settings pipeline and preserve all unrelated schema content", () => {
  const original = world(), before = JSON.stringify(original);
  const parsed = toolCallsToSchemaChanges([call({ portraitAssetRef: portrait, bannerAssetRef: portrait, bannerCrop })], original)[0]!;
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.change, { action: "update", entityType: "settings", id: "world-media", data: {
    world_media_operation: { portraitAssetRef: portrait, bannerAssetRef: portrait, bannerCrop } } });
  const result = executeApplyChanges(original, [parsed.change!]);
  assert.equal(result.success, true); assert.equal(result.world.bannerImageUrl, portrait);
  assert.deepEqual(result.world.coverCrop, coverCrop); assert.deepEqual(result.world.galleryCoverCrop, original.galleryCoverCrop);
  assert.equal(result.world.avatar, original.avatar, "portrait is a transactional route sidecar, never schema.avatar");
  assert.deepEqual(result.world.rootComponent, original.rootComponent); assert.deepEqual(result.world.settings, original.settings);
  assert.deepEqual((result.world as unknown as Record<string, unknown>).customData, { source: "PRESERVE PRIVATE CUSTOM SOURCE" });
  assert.equal(JSON.stringify(original), before);
});

test("portrait-only, framing-only and explicit null changes stay independent", () => {
  const source = world(), before = JSON.stringify(source);
  assert.deepEqual(applyWorldMediaOperation(source, { portraitAssetRef: portrait }), { portraitAssetRef: portrait });
  assert.equal(JSON.stringify(source), before);
  applyWorldMediaOperation(source, { coverCrop: { ...coverCrop, zoom: 2 } });
  assert.equal(source.coverCrop!.zoom, 2); assert.equal(source.bannerImageUrl, banner); assert.deepEqual(source.bannerCrop, bannerCrop);
  applyWorldMediaOperation(source, { bannerAssetRef: null });
  assert.equal(source.bannerImageUrl, ""); assert.deepEqual(source.bannerCrop, bannerCrop, "clearing art preserves framing unless explicitly cleared");
  applyWorldMediaOperation(source, { bannerCrop: null, coverCrop: null, portraitAssetRef: null });
  assert.equal(Object.hasOwn(source, "coverCrop"), false); assert.equal(Object.hasOwn(source, "bannerCrop"), false);
  assert.deepEqual(source.galleryCoverCrop, { ...coverCrop, x: 5 }); assert.equal(source.avatar, "deprecated-avatar.png");
});

test("malformed native metadata fails atomically and existing generation settings retain their semantics", () => {
  const original = world(), before = JSON.stringify(original);
  const result = executeApplyChanges(original, [{ action: "update", entityType: "settings", id: "world-media",
    data: { world_media_operation: { bannerAssetRef: portrait, coverCrop: { x: 60 } } } }]);
  assert.equal(result.success, false); assert.equal(result.world, original); assert.equal(JSON.stringify(original), before);
  assert.ok(toolCallsToSchemaChanges([call({ bannerAssetRef: "@asset:not-uuid" })], original)[0]!.error);
  const settings = executeApplyChanges(original, [{ action: "update", entityType: "settings", id: "settings", data: { temperature: 0.8 } }]);
  assert.equal(settings.success, true); assert.equal(settings.world.settings.temperature, 0.8); assert.equal(settings.world.bannerImageUrl, banner);
});

test("media reads report the actual supplied portrait and banner fallback without leaking full custom schemas", () => {
  const source = world(), rawPortrait = "worlds/fixture/thumbnail/current.png";
  const direct = readWorldMedia(source, rawPortrait);
  assert.deepEqual(executeReadEntities(source, ["world-media"], { thumbnailUrl: rawPortrait }).results["world-media"], direct);
  assert.equal(direct.thumbnailUrl, rawPortrait); assert.equal(direct.bannerAssetRef, banner);
  assert.equal(direct.pageBannerImageUrl, banner); assert.equal(direct.pageBannerSource, "banner");
  assert.deepEqual(direct.coverCrop, coverCrop); assert.deepEqual(direct.bannerCrop, bannerCrop);
  assert.doesNotMatch(JSON.stringify(direct), /PRIVATE CUSTOM|CUSTOM SOURCE|deprecated-avatar/);
  source.bannerImageUrl = "";
  assert.equal(readWorldMedia(source, rawPortrait).pageBannerImageUrl, rawPortrait); assert.equal(readWorldMedia(source, rawPortrait).pageBannerSource, "portrait");
  assert.equal(readWorldMedia(source, null).pageBannerSource, "none");
  assert.equal(readWorldMedia(source).thumbnailUrl, null, "never invent a portrait ref from deprecated avatar");
});

test("inventory and prompt explain native independent card art without requiring image generation", async () => {
  const context = await resolveContext(world(), "Use my uploaded portrait and page banner", { userId: "fixture-owner", thumbnailUrl: "fixture/current-cover.png" });
  assert.match(context.inventory, /world-media/); assert.match(context.inventory, /fixture\/current-cover\.png/);
  assert.match(context.inventory, /22222222-2222-4222-8222-222222222222/);
  const prompt = buildSystemPrompt(context).static;
  assert.match(prompt, /write_world_media/); assert.match(prompt, /portraitAssetRef/); assert.match(prompt, /bannerAssetRef/);
  assert.match(prompt, /null.*clear|clear.*null/i); assert.match(prompt, /banner.*16:5|16:5.*banner/i); assert.match(prompt, /contain/);
  const imageProposal = readFileSync(new URL("./image-proposal.ts", import.meta.url), "utf8");
  assert.doesNotMatch(imageProposal, /No tool sets the card cover/); assert.match(imageProposal, /write_world_media/);
});


test("legacy crop extras remain stored while media reads expose only recognized framing", () => {
  const source = world();
  source.bannerCrop = { ...bannerCrop, privateExtra: "PRIVATE CROP SOURCE" } as typeof bannerCrop;
  const result = readWorldMedia(source, "fixture/portrait.png");
  assert.deepEqual(result.bannerCrop, bannerCrop);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE CROP SOURCE/);
  assert.equal((source.bannerCrop as unknown as { privateExtra: string }).privateExtra, "PRIVATE CROP SOURCE");
});
