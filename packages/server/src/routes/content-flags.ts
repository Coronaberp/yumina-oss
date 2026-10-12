import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONTENT_FLAG_THRESHOLD } from "@yumina/shared";
import { kevContentClassifier } from "../lib/kev-content-classifier.js";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { checkRateLimit } from "../middleware/rate-limit.js";
import { contentFlagService, contentFlagTurn, currentContentFlag } from "../lib/content-flag-service.js";
import type { AppEnv } from "../lib/types.js";

export const contentFlagRoutes = new Hono<AppEnv>();
contentFlagRoutes.use("/sessions/*", authMiddleware);
contentFlagRoutes.use("/sessions/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

const playerExpressionSchema = z.object({ choice: z.string().trim().min(1).max(8000) }).strict();
contentFlagRoutes.post("/sessions/:sessionId/player-expression", async c => {
  const parsed = playerExpressionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose a valid player action or dialogue" }, 400);
  const sid = c.req.param("sessionId"), uid = c.get("user").id;
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, sid), eq(playSessions.userId, uid)));
  if (!owned) return c.json({ error: "Session not found" }, 404);
  const rate = await checkRateLimit(`player-expression:${uid}`, 30);
  if (rate) { c.header("Retry-After", String(rate.retryAfter)); return c.json(rate, 429); }
  const expression = await kevContentClassifier.classifyPlayerExpression(parsed.data.choice);
  return c.json({ data: { expression } });
});

contentFlagRoutes.get("/sessions/:sessionId/content-flags", async c => {
  const sid = c.req.param("sessionId"), uid = c.get("user").id;
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, sid), eq(playSessions.userId, uid)));
  if (!owned) return c.json({ error: "Session not found" }, 404);
  const rows = (await db.select().from(messages).where(eq(messages.sessionId, sid))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(50)).reverse();
  return c.json({ data: {
    threshold: CONTENT_FLAG_THRESHOLD, turn: contentFlagTurn(rows),
    messages: rows.filter(row => row.role === "user" || row.role === "assistant").map(row => ({
      id: row.id, role: row.role, activeSwipeIndex: row.activeSwipeIndex ?? 0,
      status: row.status, contentFlags: currentContentFlag(row),
    })),
  } });
});

const retrySchema = z.object({ messageId: z.string().min(1).max(128) }).strict();
contentFlagRoutes.post("/sessions/:sessionId/content-flags/retry", async c => {
  const parsed = retrySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose a message to classify" }, 400);
  const sid = c.req.param("sessionId"), uid = c.get("user").id;
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, sid), eq(playSessions.userId, uid)));
  if (!owned) return c.json({ error: "Session not found" }, 404);
  const [row] = await db.select().from(messages).where(and(eq(messages.id, parsed.data.messageId), eq(messages.sessionId, sid)));
  if (!row || !["user", "assistant"].includes(row.role)) return c.json({ error: "Message not found" }, 404);
  if (row.role === "assistant" && row.status !== "complete") return c.json({ error: "Only completed responses can be classified" }, 409);
  const rate = await checkRateLimit(`content-flags:${uid}`, 10);
  if (rate) { c.header("Retry-After", String(rate.retryAfter)); return c.json(rate, 429); }
  // Repeated taps do not reset a running job's compare-and-swap nonce.
  if (row.contentFlags?.status === "pending") contentFlagService.enqueue(row.id);
  else await contentFlagService.retry(row.id);
  return c.json({ data: { status: "pending" } }, 202);
});
