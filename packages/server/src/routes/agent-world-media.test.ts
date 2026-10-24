import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Hono } from "hono";
import { and, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { agentRuns, apiKeys, assets, user, userAssets, worlds, worldSnapshots } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import type { AppEnv } from "../lib/types.js";
import { agentRoutes } from "./agent.js";
import { studioRoutes } from "./studio.js";

// Real route handlers, isolated PGlite, and a native-tool SSE mock; no paid calls
// or real user assets are involved. Closing PGlite also checks clean shutdown.
after(async () => { if ("close" in db.$client && typeof db.$client.close === "function") await db.$client.close(); });

interface Call { name: string; args: Record<string, unknown>; id?: string }
interface ToolMessage { role: string; tool_call_id?: string; content?: unknown }

const coverCrop = { x: 12, y: -8, zoom: 1.3, fit: "cover" };
const bannerCrop = { x: -9, y: 11, zoom: 0.8, fit: "contain" };

function nativeCall(call: Call, index: number, round: number) {
  return { index, id: call.id ?? `fixture-${round}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } };
}

function toolResult(messages: unknown, id: string): Record<string, unknown> {
  const message = (messages as ToolMessage[]).find(item => item.role === "tool" && item.tool_call_id === id);
  assert.ok(message, `Missing persisted result for ${id}`);
  return typeof message.content === "string" ? JSON.parse(message.content) : message.content as Record<string, unknown>;
}

function readMedia(messages: unknown, id: string): Record<string, unknown> {
  const result = toolResult(messages, id);
  assert.ok(result["world-media"], JSON.stringify(result));
  return result["world-media"] as Record<string, unknown>;
}

async function fixture(t: TestContext) {
  const ownerId = crypto.randomUUID(), foreignId = crypto.randomUUID();
  const worldId = crypto.randomUUID(), foreignWorldId = crypto.randomUUID();
  const portraitId = crypto.randomUUID(), bannerId = crypto.randomUUID();
  const libraryId = crypto.randomUUID(), foreignWorldImageId = crypto.randomUUID();
  const foreignLibraryId = crypto.randomUUID(), audioId = crypto.randomUUID();
  const portraitUrl = `worlds/${worldId}/portrait.webp`;
  const libraryUrl = `user-assets/${ownerId}/landscape.webp`;
  const originalSchema = {
    id: worldId, version: "1.0.0", name: "Media fixture", description: "Keep custom lore", author: "Fixture author",
    entries: [], variables: [], rules: [], components: [], audioTracks: [],
    avatar: "legacy-avatar-must-not-be-replaced.webp",
    bannerImageUrl: `@asset:${bannerId}`,
    coverCrop: { x: 0, y: 0, zoom: 1, fit: "cover" },
    bannerCrop: { x: 1, y: 2, zoom: 1.1, fit: "cover" },
    galleryCoverCrop: { x: 3, y: 4, zoom: 1.2, fit: "contain" },
    rootComponent: { id: "custom-stage", name: "Custom stage", entryFile: "index.tsx", files: { "index.tsx": "export default function Stage() { return <div>Authored content</div>; }", "custom.tsx": "export const authoredColor = 'purple';" }, updatedAt: "2026-10-23T00:00:00.000Z" },
  };
  await db.insert(user).values([
    { id: ownerId, name: "Media fixture", email: `${ownerId}@example.test` },
    { id: foreignId, name: "Other fixture", email: `${foreignId}@example.test` },
  ]);
  await db.insert(worlds).values([
    { id: worldId, creatorId: ownerId, name: "Media fixture", thumbnailUrl: "old-portrait.webp", schema: originalSchema },
    { id: foreignWorldId, creatorId: foreignId, name: "Other fixture", schema: { ...originalSchema, id: foreignWorldId } },
  ]);
  await db.insert(assets).values([
    { id: portraitId, worldId, type: "image", filename: "portrait.webp", url: portraitUrl, mimeType: "image/webp" },
    { id: bannerId, worldId, type: "image", filename: "banner.webp", url: `worlds/${worldId}/banner.webp`, mimeType: "image/webp" },
    { id: foreignWorldImageId, worldId: foreignWorldId, type: "image", filename: "foreign.webp", url: `worlds/${foreignWorldId}/private.webp`, mimeType: "image/webp" },
  ]);
  await db.insert(userAssets).values([
    { id: libraryId, userId: ownerId, type: "image", filename: "landscape.webp", url: libraryUrl, mimeType: "image/webp" },
    { id: foreignLibraryId, userId: foreignId, type: "image", filename: "foreign.webp", url: `user-assets/${foreignId}/private.webp`, mimeType: "image/webp" },
    { id: audioId, userId: ownerId, type: "audio", filename: "sound.ogg", url: `user-assets/${ownerId}/sound.ogg`, mimeType: "audio/ogg" },
  ]);
  const encrypted = encryptApiKey("isolated-media-fixture-key");
  const profileId = crypto.randomUUID();
  await db.insert(apiKeys).values({ id: profileId, userId: ownerId, provider: "custom", baseUrl: "https://media-fixture.example/v1", metadata: { defaultModel: "fixture-model", contextWindow: 131072 }, encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag });
  await db.update(user).set({ preferences: { nsfwApiKeyId: profileId } }).where(eq(user.id, ownerId));

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: ownerId } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of agentRoutes.routes.filter(r => r.method === "POST" && ["/:worldId/agent/start", "/:worldId/agent/approve"].includes(r.path))) app.post(route.path, route.handler);
  for (const route of agentRoutes.routes.filter(r => r.method === "GET" && r.path === "/:worldId/agent/changes/:runId/:toolCallId")) app.get(route.path, route.handler);
  for (const route of studioRoutes.routes.filter(r => r.method === "POST" && r.path === "/:worldId/rollback/:snapshotId")) app.post(route.path, route.handler);
  for (const route of studioRoutes.routes.filter(r => r.method === "GET" && r.path === "/:worldId/snapshots")) app.get(route.path, route.handler);

  const requests: Array<Record<string, unknown>> = [];
  let queue: Call[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      assert.equal(String(url), "https://media-fixture.example/v1/models");
      return Response.json({ data: [] });
    }
    assert.equal(String(url), "https://media-fixture.example/v1/chat/completions", "No live provider or image generation is permitted");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "fixture-model");
    requests.push(request);
    assert.ok(requests.length < 50, "Fixture must finish without an agent retry loop");
    const calls = queue.shift();
    const delta = calls?.length ? { tool_calls: calls.map((call, index) => nativeCall(call, index, requests.length)) } : { content: "Artwork fixture complete." };
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
      "data: [DONE]", "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const post = (path: string, body: unknown) => app.request(`/${worldId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(`/${worldId}/${path}`);
  const saved = async () => (await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!;
  async function run(calls: Call[][], pending?: Call, allowError = false, approved = true) {
    // Exercise the normal plan/progress protocol rather than bypassing the task runner.
    queue = approved ? [[{ name: "update_task_plan", args: { requirements: [{ id: "fixture-structure", text: "Preserve a valid card while applying the fixture artwork operations.", checks: [{ kind: "validation", mode: "structure" }] }] } }], ...calls, [{ name: "check_task_progress", args: {} }]] : [];
    let response: Response;
    let runId: string;
    if (pending) {
      const [paused] = await db.insert(agentRuns).values({ worldId, userId: ownerId, model: "custom/obsolete-model", status: "awaiting_approval", maxIterations: 5, messages: [{ role: "user", content: "Card artwork." }], pendingToolCalls: [nativeCall(pending, 0, 0)] }).returning();
      runId = paused!.id;
      response = await post("agent/approve", { runId, approved });
    } else {
      response = await post("agent/start", { message: "Card artwork." });
      runId = response.headers.get("X-Agent-Run-Id")!;
    }
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.ok(runRow, stream);
    assert.ok(runRow.status === "completed" || (allowError && runRow.status === "error"), stream);
    return { stream, run: runRow, saved: await saved() };
  }
  return { ownerId, worldId, portraitId, bannerId, libraryId, foreignWorldImageId, foreignLibraryId, audioId, portraitUrl, libraryUrl, originalSchema, post, get, run, saved, requests };
}

function schemaOf(row: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["saved"]>>) {
  return row.schema as Record<string, unknown>;
}

test("native world media start writes actual portrait and independent banner, then reads persisted media", async t => {
  const f = await fixture(t);
  const result = await f.run([
    [{ name: "write_world_media", id: "write-media", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: `@asset:${f.libraryId}`, coverCrop, bannerCrop } }],
    [{ name: "read_entities", id: "read-media", args: { ids: ["world-media"] } }],
  ]);
  assert.equal(result.saved.thumbnailUrl, f.portraitUrl, result.stream);
  const schema = schemaOf(result.saved);
  assert.equal(schema.bannerImageUrl, `@asset:${f.libraryId}`);
  assert.deepEqual(schema.coverCrop, coverCrop);
  assert.deepEqual(schema.bannerCrop, bannerCrop);
  assert.equal(schema.avatar, f.originalSchema.avatar, "The deprecated avatar field is not the actual portrait");
  assert.deepEqual(schema.rootComponent, f.originalSchema.rootComponent);
  assert.deepEqual(schema.galleryCoverCrop, f.originalSchema.galleryCoverCrop);
  const media = readMedia(result.run.messages, "read-media");
  assert.equal(media.thumbnailUrl, f.portraitUrl);
  assert.equal(media.bannerAssetRef, `@asset:${f.libraryId}`);
  assert.deepEqual(media.coverCrop, coverCrop);
  assert.deepEqual(media.bannerCrop, bannerCrop);
  assert.ok(f.requests.slice(1).some(request => (request.messages as ToolMessage[]).some(message => message.role === "tool" && message.tool_call_id === "write-media")), "The model receives the actual write result");
  assert.equal((await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, result.run.id))).length, 1);
});

test("portrait from the creator library, banner-only edits, and null clears stay independent", async t => {
  const f = await fixture(t);
  const portrait = await f.run([[{ name: "write_world_media", args: { portraitAssetRef: `@asset:${f.libraryId}` } }]]);
  assert.equal(portrait.saved.thumbnailUrl, f.libraryUrl);
  assert.equal(schemaOf(portrait.saved).bannerImageUrl, f.originalSchema.bannerImageUrl);
  const framed = await f.run([[{ name: "write_world_media", args: { coverCrop } }]]);
  assert.equal(framed.saved.thumbnailUrl, f.libraryUrl);
  assert.equal(schemaOf(framed.saved).bannerImageUrl, f.originalSchema.bannerImageUrl);
  assert.deepEqual(schemaOf(framed.saved).coverCrop, coverCrop);
  assert.deepEqual(schemaOf(framed.saved).bannerCrop, f.originalSchema.bannerCrop);
  const banner = await f.run([[{ name: "write_world_media", args: { bannerAssetRef: `@asset:${f.portraitId}`, bannerCrop } }]]);
  assert.equal(banner.saved.thumbnailUrl, f.libraryUrl);
  assert.deepEqual(schemaOf(banner.saved).coverCrop, coverCrop);
  const clearedBanner = await f.run([[{ name: "write_world_media", args: { bannerAssetRef: null, bannerCrop: null } }], [{ name: "read_entities", id: "clear-read", args: { ids: ["world-media"] } }]]);
  assert.equal(clearedBanner.saved.thumbnailUrl, f.libraryUrl, "Banner fallback leaves the portrait available");
  assert.ok(!schemaOf(clearedBanner.saved).bannerImageUrl);
  assert.ok(!schemaOf(clearedBanner.saved).bannerCrop);
  const cleared = readMedia(clearedBanner.run.messages, "clear-read");
  assert.equal(cleared.bannerAssetRef, null);
  assert.equal(cleared.thumbnailUrl, f.libraryUrl);
  assert.equal(cleared.pageBannerImageUrl, f.libraryUrl);
  assert.equal(cleared.pageBannerSource, "portrait");
  const clearedPortrait = await f.run([[{ name: "write_world_media", args: { portraitAssetRef: null, coverCrop: null } }]]);
  assert.equal(clearedPortrait.saved.thumbnailUrl, null);
  assert.ok(!schemaOf(clearedPortrait.saved).coverCrop);
  assert.deepEqual(schemaOf(clearedPortrait.saved).rootComponent, f.originalSchema.rootComponent);
});

test("every combined media reference is validated before any native start mutation", async t => {
  const f = await fixture(t);
  for (const [label, invalid] of [
    ["another world's image", `@asset:${f.foreignWorldImageId}`],
    ["another user's library", `@asset:${f.foreignLibraryId}`],
    ["owned audio", `@asset:${f.audioId}`],
    ["missing UUID", `@asset:${crypto.randomUUID()}`],
    ["non-UUID reference", "@asset:portrait"],
    ["external URL", "https://not-permitted.example/portrait.png"],
  ]) {
    await t.test(label!, async () => {
      const before = await f.saved();
      const result = await f.run([[{ name: "write_world_media", id: "invalid-media", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: invalid } }]], undefined, true);
      assert.equal(result.saved.thumbnailUrl, before.thumbnailUrl, result.stream);
      assert.deepEqual(result.saved.schema, before.schema, "An invalid banner must not partially change portrait/schema");
      assert.ok(typeof toolResult(result.run.messages, "invalid-media").error === "string", "Rejected image has an actionable persisted tool error");
    });
  }
  const before = await f.saved();
  const reversed = await f.run([[{ name: "write_world_media", args: { portraitAssetRef: `@asset:${f.foreignLibraryId}`, bannerAssetRef: `@asset:${f.bannerId}`, bannerCrop } }]]);
  assert.equal(reversed.saved.thumbnailUrl, before.thumbnailUrl);
  assert.deepEqual(reversed.saved.schema, before.schema, "An invalid portrait must not partially change banner/framing");
  const retry = await f.run([[{ name: "write_world_media", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: `@asset:${f.libraryId}` } }]]);
  assert.equal(retry.saved.thumbnailUrl, f.portraitUrl, "A valid retry after rejected references succeeds");
  assert.equal(schemaOf(retry.saved).bannerImageUrl, `@asset:${f.libraryId}`);
});

test("legacy approval uses the same actual portrait write and asset validation", async t => {
  const f = await fixture(t);
  const approved = await f.run([[{ name: "read_entities", id: "approved-read", args: { ids: ["world-media"] } }]], { name: "write_world_media", id: "legacy-write", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: `@asset:${f.libraryId}`, bannerCrop } });
  assert.equal(approved.saved.thumbnailUrl, f.portraitUrl, approved.stream);
  assert.equal(approved.run.context?.studioAppliedChanges, true, "A saved legacy artwork change enables its Undo lookup");
  assert.equal(schemaOf(approved.saved).bannerImageUrl, `@asset:${f.libraryId}`);
  assert.deepEqual(schemaOf(approved.saved).rootComponent, f.originalSchema.rootComponent);
  assert.equal(readMedia(approved.run.messages, "approved-read").thumbnailUrl, f.portraitUrl);
  const snapshotsResponse = await f.get(`snapshots?agentRunId=${approved.run.id}&includeSchema=true`);
  assert.equal(snapshotsResponse.status, 200);
  const snapshots = (await snapshotsResponse.json() as { data: Array<{ id: string; schemaData: Record<string, unknown>; thumbnailUrl: string | null }> }).data;
  assert.equal(snapshots.length, 1, "The real Undo lookup exposes the successful approval snapshot");
  assert.equal(snapshots[0]!.thumbnailUrl, "old-portrait.webp");
  assert.equal(snapshots[0]!.schemaData.id, f.worldId, "The API decodes stored snapshot material into the card schema");
  assert.deepEqual(snapshots[0]!.schemaData.rootComponent, f.originalSchema.rootComponent);
  const [storedSnapshot] = await db.select().from(worldSnapshots).where(eq(worldSnapshots.id, snapshots[0]!.id));
  assert.notDeepEqual(storedSnapshot!.schemaData, snapshots[0]!.schemaData, "Storage retains the media envelope for actual portrait Undo");
  const before = await f.saved();
  const noop = await f.run([], { name: "write_world_media", id: "legacy-noop", args: { portraitAssetRef: `@asset:${f.portraitId}` } });
  assert.notEqual(noop.run.context?.studioAppliedChanges, true, "Reapplying the actual portrait is not a material change");
  assert.deepEqual((await (await f.get(`snapshots?agentRunId=${noop.run.id}`)).json() as { data: unknown[] }).data, []);
  const rejected = await f.run([], { name: "write_world_media", id: "legacy-invalid", args: { portraitAssetRef: `@asset:${f.libraryId}`, bannerAssetRef: `@asset:${f.foreignLibraryId}` } });
  assert.equal(rejected.saved.thumbnailUrl, before.thumbnailUrl);
  assert.deepEqual(rejected.saved.schema, before.schema);
  assert.notEqual(rejected.run.context?.studioAppliedChanges, true);
  assert.deepEqual((await (await f.get(`snapshots?agentRunId=${rejected.run.id}`)).json() as { data: unknown[] }).data, []);
  assert.ok(typeof toolResult(rejected.run.messages, "legacy-invalid").error === "string");
  const declined = await f.run([], { name: "write_world_media", id: "legacy-declined", args: { portraitAssetRef: `@asset:${f.libraryId}` } }, false, false);
  assert.notEqual(declined.run.context?.studioAppliedChanges, true, "Explicit rejection never enables Undo");
  assert.equal(declined.saved.thumbnailUrl, before.thumbnailUrl);
  assert.deepEqual(declined.saved.schema, before.schema);
  assert.deepEqual((await (await f.get(`snapshots?agentRunId=${declined.run.id}`)).json() as { data: unknown[] }).data, []);
  const undo = await f.post(`rollback/${snapshots[0]!.id}`, {});
  assert.equal(undo.status, 200, await undo.text());
  assert.equal((await f.saved()).thumbnailUrl, "old-portrait.webp", "The API snapshot ID can restore the actual pre-approval portrait");
});

test("a legacy approval marker failure does not report a committed portrait change as failed", async t => {
  const f = await fixture(t);
  // Keep the fault boundary independent of Postgres/PGlite's generic builders.
  type UpdateBuilder = { set(values: Record<string, unknown>): unknown };
  const database = db as unknown as { update(table: unknown): UpdateBuilder };
  const originalUpdate = database.update;
  const dialect = new PgDialect();
  let injected = false;
  database.update = table => {
    const builder = originalUpdate.call(database, table);
    if (table !== agentRuns) return builder;
    const originalSet = builder.set;
    builder.set = values => {
      const context = values.context;
      if (!injected && context && typeof context === "object" && "queryChunks" in context
        && dialect.sqlToQuery(context as SQL).sql.includes("studioAppliedChanges")) {
        injected = true;
        throw new Error("isolated marker persistence failure");
      }
      return originalSet.call(builder, values);
    };
    return builder;
  };
  try {
    const result = await f.run([], { name: "write_world_media", id: "marker-failed-write", args: { portraitAssetRef: `@asset:${f.portraitId}` } });
    assert.equal(injected, true, "The fixture failed only the ancillary applied-change marker");
    assert.equal(result.saved.thumbnailUrl, f.portraitUrl);
    assert.equal(result.run.status, "completed");
    assert.equal(toolResult(result.run.messages, "marker-failed-write").error, undefined, "Legacy success result remains successful");
    assert.equal(toolResult(result.run.messages, "marker-failed-write").thumbnailUrl, f.portraitUrl);
    assert.equal((await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, result.run.id))).length, 1, "The committed change retains its saved undo snapshot");
  } finally { database.update = originalUpdate; }
});

test("native portrait compare resolves actual storage URLs and does not invent a change on reassignment", async t => {
  const f = await fixture(t);
  const result = await f.run([[{ name: "write_world_media", id: "compare-portrait", args: { portraitAssetRef: `@asset:${f.portraitId}` } }]]);
  const response = await f.get(`agent/changes/${result.run.id}/compare-portrait`);
  assert.equal(response.status, 200);
  const compare = (await response.json() as { data: { original: string; changed: string } }).data;
  assert.equal(JSON.parse(compare.original).thumbnailUrl, "old-portrait.webp");
  assert.equal(JSON.parse(compare.changed).thumbnailUrl, f.portraitUrl, "Compare reports the stored portrait URL, never its @asset argument as thumbnailUrl");
  const noop = await f.run([[{ name: "write_world_media", id: "compare-same", args: { portraitAssetRef: `@asset:${f.portraitId}` } }]]);
  const noopResponse = await f.get(`agent/changes/${noop.run.id}/compare-same`);
  assert.equal(noopResponse.status, 200);
  const noopCompare = (await noopResponse.json() as { data: { original: string; changed: string } }).data;
  assert.deepEqual(JSON.parse(noopCompare.original), JSON.parse(noopCompare.changed), "Reassigning the current image produces no invented portrait difference");
  await db.delete(assets).where(eq(assets.id, f.portraitId));
  const missingResponse = await f.get(`agent/changes/${result.run.id}/compare-portrait`);
  assert.equal(missingResponse.status, 200);
  const missing = JSON.parse((await missingResponse.json() as { data: { changed: string } }).data.changed);
  assert.equal(missing.thumbnailUrlKnown, false);
  assert.equal(missing.thumbnailUrl, undefined, "Deleted historical assets do not get a guessed storage URL");
  assert.equal(missing.requestedPortraitAssetRef, `@asset:${f.portraitId}`);
});

test("a deleted historical banner does not hide a valid portrait in combined-media comparison", async t => {
  const f = await fixture(t);
  const combined = await f.run([[{ name: "write_world_media", id: "compare-combined", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: `@asset:${f.libraryId}` } }]]);
  await db.delete(userAssets).where(eq(userAssets.id, f.libraryId));
  const response = await f.get(`agent/changes/${combined.run.id}/compare-combined`);
  assert.equal(response.status, 200);
  const changed = JSON.parse((await response.json() as { data: { changed: string } }).data.changed);
  assert.equal(changed.thumbnailUrl, f.portraitUrl, "Deleting only the banner does not make the historical portrait URL unknown");
  assert.equal(changed.bannerAssetRef, `@asset:${f.libraryId}`);
});

test("Studio Undo and Undo-of-Undo restore actual portrait with banner and custom content", async t => {
  const f = await fixture(t);
  const changed = await f.run([[{ name: "write_world_media", args: { portraitAssetRef: `@asset:${f.portraitId}`, bannerAssetRef: `@asset:${f.libraryId}`, coverCrop, bannerCrop } }]]);
  const [snapshot] = await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, changed.run.id));
  assert.ok(snapshot, changed.stream);
  const undo = await f.post(`rollback/${snapshot.id}`, {});
  assert.equal(undo.status, 200, await undo.text());
  const restored = await f.saved();
  assert.equal(restored.thumbnailUrl, "old-portrait.webp");
  const restoredSchema = schemaOf(restored);
  for (const field of ["bannerImageUrl", "coverCrop", "bannerCrop", "rootComponent", "galleryCoverCrop", "avatar"] as const) assert.deepEqual(restoredSchema[field], f.originalSchema[field], field);
  const [backup] = await db.select().from(worldSnapshots).where(and(eq(worldSnapshots.worldId, f.worldId), eq(worldSnapshots.label, "Before rollback")));
  assert.ok(backup, "Undo keeps a reversible backup");
  const redo = await f.post(`rollback/${backup.id}`, {});
  assert.equal(redo.status, 200, await redo.text());
  const reapplied = await f.saved();
  assert.equal(reapplied.thumbnailUrl, f.portraitUrl);
  assert.equal(schemaOf(reapplied).bannerImageUrl, `@asset:${f.libraryId}`);
  assert.deepEqual(schemaOf(reapplied).coverCrop, coverCrop);
  assert.deepEqual(schemaOf(reapplied).bannerCrop, bannerCrop);
  assert.deepEqual(schemaOf(reapplied).rootComponent, f.originalSchema.rootComponent);
});

test("historical portrait comparisons omit unknown fallback media without hiding an explicit banner", async t => {
  const f = await fixture(t);
  await db.update(worlds).set({ schema: { ...f.originalSchema, bannerImageUrl: "" } }).where(eq(worlds.id, f.worldId));
  const result = await f.run([[{ name: "write_world_media", id: "historical-portrait", args: { portraitAssetRef: `@asset:${f.portraitId}` } }]]);
  const [snapshot] = await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, result.run.id));
  const historicalSchema = snapshot!.schemaData.schema as Record<string, unknown>;
  assert.ok(historicalSchema, "The fixture starts with a tracked material snapshot");
  // Older snapshots contain the complete schema but do not record portraits.
  await db.update(worldSnapshots).set({ schemaData: historicalSchema }).where(eq(worldSnapshots.id, snapshot!.id));
  const compare = async () => {
    const response = await f.get(`agent/changes/${result.run.id}/historical-portrait`);
    assert.equal(response.status, 200);
    const data = (await response.json() as { data: { original: string; changed: string } }).data;
    return { original: JSON.parse(data.original) as Record<string, unknown>, changed: JSON.parse(data.changed) as Record<string, unknown> };
  };
  const assertUnknownFallback = (media: Record<string, unknown>) => {
    assert.equal(media.thumbnailUrlKnown, false);
    for (const field of ["thumbnailUrl", "pageBannerImageUrl", "pageBannerSource"]) {
      assert.equal(Object.hasOwn(media, field), false, `${field} must remain unknown instead of claiming absence`);
    }
  };
  const knownPortrait = await compare();
  assertUnknownFallback(knownPortrait.original);
  assert.equal(knownPortrait.changed.thumbnailUrl, f.portraitUrl);
  assert.equal(knownPortrait.changed.pageBannerImageUrl, f.portraitUrl);
  assert.equal(knownPortrait.changed.pageBannerSource, "portrait");
  await db.delete(assets).where(eq(assets.id, f.portraitId));
  const missingPortrait = await compare();
  assertUnknownFallback(missingPortrait.original);
  assertUnknownFallback(missingPortrait.changed);
  assert.equal(missingPortrait.changed.requestedPortraitAssetRef, `@asset:${f.portraitId}`);
  const explicitBanner = `@asset:${f.bannerId}`;
  await db.update(worldSnapshots).set({ schemaData: { ...historicalSchema, bannerImageUrl: explicitBanner } }).where(eq(worldSnapshots.id, snapshot!.id));
  const withBanner = await compare();
  for (const media of [withBanner.original, withBanner.changed]) {
    assert.equal(media.thumbnailUrlKnown, false);
    assert.equal(Object.hasOwn(media, "thumbnailUrl"), false);
    assert.equal(media.pageBannerImageUrl, explicitBanner, "An explicit historical banner is independent of the unknown portrait");
    assert.equal(media.pageBannerSource, "banner");
  }
});
