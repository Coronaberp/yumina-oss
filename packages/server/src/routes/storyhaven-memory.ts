import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { memoryRecallBudgetSchema } from "@yumina/shared";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

export interface StoryhavenMemoryController {
  status(): Promise<unknown>;
  mutate(action: string, payload: Record<string, unknown>): Promise<unknown>;
}
export type StoryhavenControllerFactory = (
  ownerUserId: string,
  sessionId: string,
) => Promise<StoryhavenMemoryController | null>;
export const memorySettingsSchema = z
  .object({
    model: z.string().trim().min(1).max(256).nullable().optional(),
    language: z.string().min(1).max(100).optional(),
    memoryBudgetTokens: memoryRecallBudgetSchema.nullable().optional(),
    batchSize: z.number().int().min(1).max(20).optional(),
    settleMarginExchanges: z.number().int().min(0).max(10).optional(),
    sessionNeighborK: z.number().int().min(1).max(50).optional(),
    sessionCandidateK: z.number().int().min(1).max(100).optional(),
    maxPinnedLoreChunks: z.number().int().min(1).max(50).optional(),
    maxFactsPerBatch: z.number().int().min(1).max(50).optional(),
    loreNeighborK: z.number().int().min(1).max(20).optional(),
    loreCandidateK: z.number().int().min(1).max(100).optional(),
    clusterBudgetTokens: z.number().int().min(10).max(2000).optional(),
    reservedFraction: z.number().min(0).max(1).optional(),
    clusterTriggerCount: z.number().int().min(1).max(50).optional(),
    clusterMultiThread: z.boolean().optional(),
    clusterMaxSummaries: z.number().int().min(1).max(10).optional(),
  })
  .strict();
const schemas: Record<string, z.ZodTypeAny> = {
  settings: z
    .object({
      backend: z.enum(["legacy", "storyhaven"]).optional(),
      settings: memorySettingsSchema.optional(),
    })
    .strict(),
  fact: z
    .object({
      id: z.string().min(1).max(1024),
      text: z.string().min(1).max(10000).optional(),
      pinned: z.boolean().optional(),
      expired: z.boolean().optional(),
    })
    .strict(),
  forget: z.object({ id: z.string().min(1).max(1024) }).strict(),
  lineage: z.object({ id: z.string().min(1).max(1024) }).strict(),
  override: z
    .object({
      loreId: z.string().min(1).max(1024),
      content: z.string().max(100000).nullable(),
    })
    .strict(),
  reveal: z
    .object({ secretId: z.string().min(1).max(1024), revealed: z.boolean() })
    .strict(),
  preview: z.object({ query: z.string().max(10000) }).strict(),
  clear: z.object({}).strict(),
  rebuild: z.object({}).strict(),
  retry: z.object({}).strict(),
};
export function createStoryhavenMemoryRoutes(
  factory: StoryhavenControllerFactory,
  authentication: MiddlewareHandler<AppEnv> = authMiddleware,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("/*", authentication);
  routes.get("/:sessionId/memory/storyhaven", async (c) => {
    const controller = await factory(
      c.get("user").id,
      c.req.param("sessionId"),
    );
    return controller
      ? c.json({ data: await controller.status() })
      : c.json({ error: "Session not found" }, 404);
  });
  for (const [action, schema] of Object.entries(schemas)) {
    const method =
      action === "settings" || action === "fact" ? "patch" : "post";
    routes[method](`/:sessionId/memory/storyhaven/${action}`, async (c) => {
      const controller = await factory(
        c.get("user").id,
        c.req.param("sessionId"),
      );
      if (!controller) return c.json({ error: "Session not found" }, 404);
      const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success)
        return c.json({ error: "Invalid memory request" }, 400);
      try {
        return c.json({
          data: await controller.mutate(
            action,
            parsed.data as Record<string, unknown>,
          ),
        });
      } catch {
        return c.json(
          { error: "Memory operation could not be completed" },
          409,
        );
      }
    });
  }
  return routes;
}
