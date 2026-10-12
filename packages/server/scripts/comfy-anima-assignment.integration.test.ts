import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";

await import("../src/test/database-fixture.js");
const [{ db }, schemaModule, workflowModule] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/lib/studio-image-workflow.js"),
]);

test("a local transparent expression is assigned while review-required output is withheld", async t => {
  const pngPath = process.env.YUMINA_ANIMA_TEST_PNG;
  assert.ok(pngPath, "set YUMINA_ANIMA_TEST_PNG to a transparent PNG produced by test-comfy-anima-live.mts");
  const bytes = await readFile(pngPath);
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 832);
  assert.equal(metadata.height, 1216);
  assert.equal(metadata.hasAlpha, true);
  assert.equal((await sharp(bytes).stats()).isOpaque, false);
  const reviewPngPath = process.env.YUMINA_ANIMA_REVIEW_PNG;
  assert.ok(reviewPngPath, "set YUMINA_ANIMA_REVIEW_PNG to a live output with detached-foreground review metadata");
  const reviewBytes = await readFile(reviewPngPath);
  const reviewMetadata = await sharp(reviewBytes).metadata();
  assert.equal(reviewMetadata.format, "png");
  assert.equal(reviewMetadata.width, 832);
  assert.equal(reviewMetadata.height, 1216);
  assert.equal(reviewMetadata.hasAlpha, true);
  assert.equal((await sharp(reviewBytes).stats()).isOpaque, false);

  const userId = randomUUID(), worldId = randomUUID(), runId = randomUUID(), assetId = randomUUID(), reviewAssetId = randomUUID(), jobId = randomUUID(), reviewJobId = randomUUID();
  t.after(async () => { await db.delete(schemaModule.user).where((await import("drizzle-orm")).eq(schemaModule.user.id, userId)); });
  await db.insert(schemaModule.user).values({ id: userId, name: "Anima Integration", email: `${userId}@integration.test` });
  const world = {
    id: worldId,
    version: "21.0.0",
    name: "Anima assignment integration",
    description: "Isolated sprite assignment test.", author: "Integration test",
    entries: [{ id: "signynn", name: "Signynn", role: "character", content: "Red twin-tails, teal eyes, a star hair clip, and a green academy uniform.", keywords: [], enabled: true }],
    variables: [], rules: [], components: [], audioTracks: [], customUI: [], settings: {},
    rootComponent: { interfaceId: "vn", entryFile: "index.tsx", files: {
      "index.tsx": "export default function Root(){return <div className=\"vn-root\"/>}",
      "scenes.ts": "export const scenes = {};\nexport const openingScenes = {};\n",
      "sprites.ts": "export const sprites = {};\n",
    } },
  } as Record<string, unknown>;
  await db.insert(schemaModule.worlds).values({ id: worldId, creatorId: userId, name: world.name as string, status: "draft", schema: world });
  await db.insert(schemaModule.agentRuns).values({ id: runId, worldId, userId, status: "completed", model: "local-e2e" });
  const source = { provider: "comfyui", imageKind: "sprite", model: "anima-base-v1.0.safetensors", seed: 846218,
    steps: 8, cfg: 1, sampler: "er_sde", scheduler: "simple", chromaColor: "#8e00ff", actualBackgroundColor: "#d492d5",
    processingStatus: "complete", reviewRequired: false, referenceRoles: [{ key: "canonical", name: "Signynn normal sprite", role: "identity" }] };
  await db.insert(schemaModule.userAssets).values({ id: assetId, userId, type: "image", filename: "signynn-happy.png",
    url: `test://asset/${assetId}`, sizeBytes: bytes.length, mimeType: "image/png", isPublic: false });
  await db.insert(schemaModule.userAssets).values({ id: reviewAssetId, userId, type: "image", filename: "signynn-neutral-review.png",
    url: `test://asset/${reviewAssetId}`, sizeBytes: reviewBytes.length, mimeType: "image/png", isPublic: false });
  await db.insert(schemaModule.generatedImageSources).values({ assetId, userId, provider: "comfyui", metadata: source });
  await db.insert(schemaModule.generatedImageSources).values({ assetId: reviewAssetId, userId, provider: "comfyui", metadata: {
    ...source, seed: 846225, processingStatus: "review_required", reviewRequired: true,
    detachedForegroundRatio: 0.0068, reviewReasons: ["detached_foreground_artifacts"],
  } });
  await db.insert(schemaModule.generationJobs).values({ id: jobId, userId, kind: "image", templateId: "studio-configured-image",
    provider: "comfyui", status: "succeeded", assetId, assetIds: [assetId], completedAt: new Date(), params: {
      worldId, runId, callId: "local-anima-happy", proposal: { target: { kind: "sprite", characterId: "signynn", expression: "happy" } },
      reviewRequired: false,
    } });
  await db.insert(schemaModule.generationJobs).values({ id: reviewJobId, userId, kind: "image", templateId: "studio-configured-image",
    provider: "comfyui", status: "succeeded", assetId: reviewAssetId, assetIds: [reviewAssetId], completedAt: new Date(), params: {
      worldId, runId, callId: "local-anima-review", proposal: { target: { kind: "sprite", characterId: "signynn", expression: "angry" } },
      reviewRequired: true, reviewReasons: ["detached_foreground_artifacts"],
    } });

  const outcome = await workflowModule.integrateCompletedStudioImageTask(userId, worldId, runId);
  const [afterIntegration] = await db.select({ params: schemaModule.generationJobs.params }).from(schemaModule.generationJobs)
    .where((await import("drizzle-orm")).eq(schemaModule.generationJobs.id, jobId));
  const [worldAfterIntegration] = await db.select({ schema: schemaModule.worlds.schema }).from(schemaModule.worlds)
    .where((await import("drizzle-orm")).eq(schemaModule.worlds.id, worldId));
  assert.equal(outcome?.assigned, 1, JSON.stringify({ outcome, params: afterIntegration?.params,
    sprites: ((worldAfterIntegration?.schema as { rootComponent?: { files?: Record<string, string> } })?.rootComponent?.files?.["sprites.ts"]) }));
  assert.equal(outcome?.unassigned, 1);
  const [savedWorld] = await db.select({ schema: schemaModule.worlds.schema }).from(schemaModule.worlds).where((await import("drizzle-orm")).eq(schemaModule.worlds.id, worldId));
  const savedRoot = (savedWorld!.schema as { rootComponent: { files: Record<string, string> } }).rootComponent;
  assert.match(savedRoot.files["sprites.ts"]!, new RegExp(`"happy"\\s*:\\s*"@asset:${assetId}"`));
  const [savedJob] = await db.select({ params: schemaModule.generationJobs.params }).from(schemaModule.generationJobs)
    .where((await import("drizzle-orm")).eq(schemaModule.generationJobs.id, jobId));
  assert.equal((savedJob!.params as Record<string, unknown>).assetStatus, "verified");
  const [savedReviewJob] = await db.select({ params: schemaModule.generationJobs.params }).from(schemaModule.generationJobs)
    .where((await import("drizzle-orm")).eq(schemaModule.generationJobs.id, reviewJobId));
  const reviewParams = savedReviewJob!.params as Record<string, unknown>;
  assert.equal(reviewParams.assetStatus, "unassigned");
  assert.match(String(reviewParams.assetReason), /Saved for review.*detached_foreground_artifacts/);
  assert.doesNotMatch(savedRoot.files["sprites.ts"]!, /"angry"\s*:/, "review-required art stays out of the character sprite map");
});
