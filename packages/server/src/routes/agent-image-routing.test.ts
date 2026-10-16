import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, generationJobs } from "../db/schema.js";
import { env } from "../lib/env.js";
import { imageGenerationService } from "../lib/image-generation/default.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import type { LLMProvider } from "../lib/llm/types.js";
import { streamAgentLoop } from "./agent.js";

for (const parallel of [false, true]) for (const contentRating of ["sfw", "nsfw"] as const)
  test(`${parallel ? "parallel" : "single"} image calls route ${contentRating} sprites and backgrounds to compatible generators`, async () => {
    const uid = crypto.randomUUID(), worldId = crypto.randomUUID();
    const edition = env.YUMINA_EDITION, enabled = env.YUMINA_STUDIO_CODEX_ENABLED;
    env.YUMINA_EDITION = "local"; env.YUMINA_STUDIO_CODEX_ENABLED = true;
    const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Image routing QA", description: "", author: "QA",
      entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
    await db.insert(user).values({ id: uid, name: "Routing QA", email: `${uid}@test.local` });
    await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
    try {
      await imageGenerationService.updateConfig(uid, { provider: "comfyui", enabled: true, baseUrl: "https://comfy.example.com", workflowMode: "anima", makeActive: true });
      for (const kinds of parallel ? [["sprite", "background"] as const] : [["sprite"] as const, ["background"] as const]) {
        const runId = crypto.randomUUID();
        await db.insert(agentRuns).values({ id: runId, worldId, userId: uid, model: "image-test", status: "running" });
        let turns = 0;
        const provider: LLMProvider = { listModels: async () => [], async *generateStream() {
          if (turns++ === 0) for (const imageKind of kinds) yield { type: "tool_call_end", content: "", toolCall: {
            id: `image-${imageKind}`, type: "function", function: { name: "generate_image", arguments: JSON.stringify({ imageKind, contentRating,
              ...(contentRating === "nsfw" ? { imageWorkflow: "codex", source: "codex" } : {}), prompt: "A first canonical design with blue and gold details." }) },
          } };
          yield { type: "done", content: "", stopReason: turns === 1 ? "tool_use" : "end_turn" };
        } };
        const app = new Hono();
        app.get("/test", c => streamAgentLoop(c, { runId, conversationId: runId, worldId, userId: uid, world,
          messages: [{ role: "user", content: "Create the requested artwork." }], model: "image-test", provider,
          isByok: true, apiKeyTier: "byok", unlimited: true, iteration: 0, maxIterations: 2, tools: STUDIO_TOOLS }));
        const output = await (await app.request("/test")).text();
        assert.doesNotMatch(output, /event: error/);
        const jobs = await db.select().from(generationJobs).where(eq(generationJobs.userId, uid));
        const current = jobs.filter(job => job.params.runId === runId);
        assert.equal(current.length, kinds.length, output);
        for (const job of current) {
          const proposal = job.params.proposal as Record<string, unknown>;
          assert.equal(job.status, "queued");
          assert.equal(job.provider, contentRating === "sfw" ? "codex" : "comfyui");
          assert.equal(proposal.imageWorkflow, contentRating === "sfw" ? "codex" : "krea");
          assert.equal(proposal.contentRating, contentRating);
          assert.ok(kinds.includes(proposal.imageKind as never));
        }
      }
    } finally {
      env.YUMINA_EDITION = edition; env.YUMINA_STUDIO_CODEX_ENABLED = enabled;
      await db.delete(user).where(eq(user.id, uid));
    }
  });
