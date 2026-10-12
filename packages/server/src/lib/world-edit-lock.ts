import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";

const LOCK_ERROR = "This card is temporarily locked. Editing is disabled.";

/** Temporary operator locks live outside the authored/exported world schema. */
export async function isWorldEditLocked(worldId: string, storedLock?: boolean): Promise<boolean> {
  if ((process.env.YUMINA_LOCKED_WORLD_IDS ?? "").split(/[\s,]+/).includes(worldId)) return true;
  if (storedLock !== undefined) return storedLock;
  const [world] = await db.select({ editingLocked: worlds.editingLocked }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  return world?.editingLocked === true;
}

export class WorldEditLockedError extends Error {
  readonly code = "WORLD_EDIT_LOCKED";
  constructor() { super(LOCK_ERROR); this.name = "WorldEditLockedError"; }
}

export async function assertWorldEditable(worldId: string, storedLock?: boolean): Promise<void> {
  if (await isWorldEditLocked(worldId, storedLock)) throw new WorldEditLockedError();
}

export const worldEditLockMiddleware: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const match = /^\/api\/(worlds|studio)\/([^/]+)(?:\/(.*))?$/.exec(c.req.path);
  if (!match) return next();
  let worldId: string;
  try { worldId = decodeURIComponent(match[2]!); } catch { return next(); }
  const suffix = (match[3] ?? "").replace(/\/$/, "");
  // Only the authenticated owner control can deliberately change the lock.
  if (match[1] === "worlds" && suffix === "editing-lock" && c.req.method === "PATCH") return next();
  // Player feedback and making a new copy do not edit the locked original.
  if (match[1] === "worlds" && /^(duplicate|rating|reviews)(\/|$)/.test(suffix)) return next();
  // A running task must remain stoppable, even after a lock is applied.
  if (match[1] === "studio" && suffix === "agent/stop") return next();
  let locked = await isWorldEditLocked(worldId);
  if (!locked && match[1] === "worlds" && suffix === "link-language") {
    const body = await c.req.raw.clone().json().catch(() => null) as { targetWorldId?: unknown } | null;
    locked = typeof body?.targetWorldId === "string" && await isWorldEditLocked(body.targetWorldId);
  }
  if (locked) return c.json({ error: LOCK_ERROR, code: "WORLD_EDIT_LOCKED" }, 403);
  return next();
};
