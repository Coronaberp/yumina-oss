import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, worlds } from "../db/schema.js";
import { requestReceipts } from "../lib/request-inspection.js";
import type { AppEnv } from "../lib/types.js";

/** Mounted beneath messageRoutes' authenticated /sessions/* middleware. */
const requestInspectionRoutes = new Hono<AppEnv>();

requestInspectionRoutes.get("/sessions/:sessionId/request-inspection-access", async c => {
  c.header("Cache-Control", "private, no-store");
  const userId = c.get("user")?.id;
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const [session] = await db.select({ id: playSessions.id })
    .from(playSessions).innerJoin(worlds, eq(worlds.id, playSessions.worldId))
    .where(and(eq(playSessions.id, c.req.param("sessionId")), eq(playSessions.userId, userId), eq(worlds.creatorId, userId))).limit(1);
  return c.json({ data: { allowed: !!session } });
});

requestInspectionRoutes.get("/sessions/:sessionId/messages/:messageId/request-inspection", async c => {
  c.header("Cache-Control", "private, no-store");
  const userId = c.get("user")?.id;
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const rawSwipe = c.req.query("swipe") ?? "0";
  if (!/^\d{1,6}$/.test(rawSwipe)) return c.json({ error: "Invalid swipe" }, 400);
  const swipeIndex = Number(rawSwipe);
  const sessionId = c.req.param("sessionId"), messageId = c.req.param("messageId");
  // Query the primary and recheck both permissions on EVERY read. No admin,
  // source-author, public-card or cached capability exception. Do not load a transcript.
  const [message] = await db.select({
    worldId: worlds.id,
    swipeCount: sql<number>`greatest(1, coalesce(${messages.swipeCount}, jsonb_array_length(${messages.swipes}), 0))`,
  }).from(messages)
    .innerJoin(playSessions, eq(playSessions.id, messages.sessionId))
    .innerJoin(worlds, eq(worlds.id, playSessions.worldId))
    .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId), eq(messages.role, "assistant"), eq(playSessions.userId, userId), eq(worlds.creatorId, userId))).limit(1);
  if (!message || swipeIndex >= Number(message.swipeCount)) return c.json({ error: "Not found" }, 404);
  const receipts = requestReceipts.get({ userId, worldId: message.worldId, sessionId, messageId, swipeIndex });
  return c.json({ data: receipts?.length ? { available: true, receipts } : { available: false, reason: "not-retained" } });
});

export { requestInspectionRoutes };
