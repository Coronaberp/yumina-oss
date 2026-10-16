import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { activeChapter } from "@yumina/engine";
import { db } from "../db/index.js";
import { playSessions } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { normalizeGameState } from "../lib/game-state.js";
import { loadSessionWorldDef } from "../lib/world-def-cache.js";
import { canSelectSessionPersona } from "../lib/persona-selection.js";

const greetingOnly = "Chapters can only be selected at the greeting. Start a new playthrough to choose another chapter.";
export function registerChapterRoutes(routes: Hono<AppEnv>) {
  routes.get("/:id/chapters", async c => {
    const userId = c.get("user").id, id = c.req.param("id");
    const [session] = await db.select().from(playSessions).where(and(eq(playSessions.id, id), eq(playSessions.userId, userId))).limit(1);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!await canSelectSessionPersona(session)) return c.json({ error: greetingOnly }, 409);
    const world = await loadSessionWorldDef(session.worldId, userId);
    if (!world) return c.json({ error: "World not found" }, 404);
    const state = normalizeGameState(world, session.state);
    const chapters = (world.chapters ?? []).filter(chapter => chapter.enabled !== false).map(chapter => ({
      id: chapter.id, name: chapter.name, timeline: chapter.timeline, date: chapter.date, greetingIds: chapter.greetingIds,
    }));
    c.header("Cache-Control", "no-store");
    return c.json({ data: { activeChapterId: activeChapter(world, state)?.id ?? null, chapters } });
  });

  // Old clients must not append a chapter boundary or reset a played save.
  // Starting chapters use the same locked greeting-swipe path as other openings.
  routes.post("/:id/chapters/transition", async c => {
    const [session] = await db.select({ id: playSessions.id }).from(playSessions).where(and(eq(playSessions.id, c.req.param("id")), eq(playSessions.userId, c.get("user").id))).limit(1);
    return session ? c.json({ error: greetingOnly }, 409) : c.json({ error: "Session not found" }, 404);
  });
}
