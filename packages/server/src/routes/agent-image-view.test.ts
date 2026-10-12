import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, userAssets, worlds, agentRuns } from "../db/schema.js";
import { putObject, deleteObject } from "../lib/s3.js";
import type { LLMProvider, GenerateParams } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";

test("view_image sends owned image pixels to the agent while preserving the creator turn and compact transcript", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID(), aid = crypto.randomUUID();
  const other = crypto.randomUUID(), foreignId = crypto.randomUUID(), textId = crypto.randomUUID();
  const key = `users/${uid}/image-view-${aid}.png`;
  const world = migrateWorldDefinition({ id: wid, version: "19.0.0", name: "Image view QA", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values([{ id: uid, name: "Image QA", email: uid + "@test.local" }, { id: other, name: "Other", email: other + "@test.local" }]);
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: rid, worldId: wid, userId: uid, model: "custom/vision", status: "running" });
  await db.insert(userAssets).values([
    { id: aid, userId: uid, type: "image", filename: "sprite.png", url: key },
    { id: foreignId, userId: other, type: "image", filename: "foreign.png", url: "never/read/foreign.png" },
    { id: textId, userId: uid, type: "audio", filename: "music.mp3", url: "never/read/music.mp3" },
  ]);
  const bytes = await sharp({ create: { width: 20, height: 16, channels: 4, background: { r: 240, g: 20, b: 10, alpha: 0.5 } } }).png().toBuffer();
  await putObject(key, bytes, "image/png");
  t.after(async () => { await deleteObject(key); await db.delete(user).where(eq(user.id, uid)); await db.delete(user).where(eq(user.id, other)); });
  let iterations = 0;
  const result = (request: GenerateParams, id: string) => JSON.parse(String(request.messages.find(message => message.role === "tool" && message.tool_call_id === id)!.content));
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    iterations++;
    if (iterations === 1) {
      assert.ok(request.tools?.some(tool => tool.function.name === "view_image"));
      for (const [id, ref] of [["owned", aid], ["foreign", foreignId], ["audio", textId]] as const) {
        yield { type: "tool_call_end", content: "", toolCall: { id, type: "function", function: { name: "view_image", arguments: JSON.stringify({ assetRef: `@asset:${ref}` }) } } };
      }
    } else {
      assert.equal(iterations, 2);
      assert.equal(result(request, "owned").width, 20);
      assert.equal(result(request, "owned").hasTransparency, true);
      assert.match(result(request, "foreign").error, /not found|authorized/i);
      assert.match(result(request, "audio").error, /image|not found/i);
      const users = request.messages.filter(message => message.role === "user");
      assert.equal(users.length, 1, "Image reading must not invent a creator turn");
      assert.ok(Array.isArray(users[0]!.content));
      const parts = users[0]!.content as Exclude<typeof users[0]["content"], string>;
      assert.equal(parts[0]!.type, "text");
      assert.equal((parts[0] as { text: string }).text, "Inspect my saved sprite.");
      const images = parts.filter(part => part.type === "image_url");
      assert.equal(images.length, 1);
      assert.match(images[0]!.image_url.url, /^data:image\/png;base64,/);
      assert.equal((await sharp(Buffer.from(images[0]!.image_url.url.split(",")[1]!, "base64")).metadata()).width, 20);
      yield { type: "text", content: "The image has red pixels and transparent pixels." };
    }
    yield { type: "done", content: "", stopReason: iterations === 1 ? "tool_use" : "end_turn" };
  } };
  const app = new Hono();
  app.get("/test", c => streamAgentLoop(c, { runId: rid, conversationId: rid, worldId: wid, userId: uid, world,
    messages: [{ role: "user", content: "Inspect my saved sprite." }], model: "custom/vision", provider,
    isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 3, tools: STUDIO_TOOLS }));
  const events = await (await app.request("/test")).text();
  assert.doesNotMatch(events, /event: error/);
  assert.equal(iterations, 2);
  const saved = (await db.select().from(agentRuns).where(eq(agentRuns.id, rid)))[0]!;
  assert.equal(saved.status, "completed");
  assert.doesNotMatch(JSON.stringify(saved.messages), /data:image/);
  assert.equal(saved.messages.find(message => message.role === "user")!.content, "Inspect my saved sprite.");
});

test("a known text-only profile reports that it cannot inspect pictures", async t => {
  const uid = crypto.randomUUID(), wid = crypto.randomUUID(), rid = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: wid, version: "19.0.0", name: "Text-only QA", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: uid, name: "Text-only QA", email: uid + "@test.local" });
  await db.insert(worlds).values({ id: wid, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  await db.insert(agentRuns).values({ id: rid, worldId: wid, userId: uid, model: "deepseek/deepseek-v4-flash" });
  t.after(async () => { await db.delete(user).where(eq(user.id, uid)); });
  let iteration = 0;
  const provider: LLMProvider = { listModels: async () => [], async *generateStream(request) {
    if (iteration++ === 0) {
      yield { type: "tool_call_end", content: "", toolCall: { id: "view", type: "function", function: { name: "view_image", arguments: JSON.stringify({ assetRef: "@asset:some-image" }) } } };
      yield { type: "done", content: "", stopReason: "tool_use" };return;
    }
    const result = JSON.parse(String(request.messages.find(message => message.role === "tool" && message.tool_call_id === "view")!.content));
    assert.match(result.error, /selected profile cannot inspect images/i);assert.equal(result.note, undefined);
    assert.doesNotMatch(JSON.stringify(request.messages), /"image_url"/);
    yield { type: "text", content: "Select an image-capable profile to inspect this picture." };yield { type: "done", content: "", stopReason: "end_turn" };
  } };
  const app = new Hono();app.get("/test", c => streamAgentLoop(c, { runId: rid, conversationId: rid, worldId: wid, userId: uid, world,
    messages: [{ role: "user", content: "Inspect this picture." }], model: "deepseek/deepseek-v4-flash", provider,
    isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 3, tools: STUDIO_TOOLS }));
  const events = await (await app.request("/test")).text();assert.doesNotMatch(events, /event: error/);assert.equal(iteration, 2);
});
