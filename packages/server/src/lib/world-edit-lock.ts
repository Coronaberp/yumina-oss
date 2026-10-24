import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { isInstallationSharedWorld } from "./installation-shared-worlds.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "./types.js";

const LOCK_ERROR = "This card is temporarily locked. Editing is disabled.";

/** Temporary operator locks live outside the authored/exported world schema. */
export async function isWorldEditLocked(worldId: string, storedLock?: boolean): Promise<boolean> {
  if ((process.env.YUMINA_LOCKED_WORLD_IDS ?? "").split(/[\s,]+/).includes(worldId)) return true;
  if (storedLock !== undefined) return storedLock;
  const [world] = await db.select({ editingLocked: worlds.editingLocked }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  return world?.editingLocked === true;
}

type WorldLockState = { creatorId: string; editingLocked: boolean; status: string | null };

/** Shared originals are always read-only for viewers. Their owner can edit
 * when the ordinary card/operator lock is off. Ownership uses the account ID. */
export async function isWorldEditLockedForUser(worldId: string, userId: string | undefined, knownState?: WorldLockState): Promise<boolean> {
  if ((process.env.YUMINA_LOCKED_WORLD_IDS ?? "").split(/[\s,]+/).includes(worldId)) return true;
  const state = knownState ?? (await db.select({ creatorId: worlds.creatorId, editingLocked: worlds.editingLocked, status: worlds.status })
    .from(worlds).where(eq(worlds.id, worldId)).limit(1))[0];
  return state?.editingLocked === true || !!state && isInstallationSharedWorld(worldId, state.status) && state.creatorId !== userId;
}

export class WorldEditLockedError extends Error {
  readonly code = "WORLD_EDIT_LOCKED";
  constructor() { super(LOCK_ERROR); this.name = "WorldEditLockedError"; }
}

export async function assertWorldEditable(worldId: string, storedLock?: boolean): Promise<void> {
  if (await isWorldEditLocked(worldId, storedLock)) throw new WorldEditLockedError();
}

export const worldEditLockMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
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
  // This middleware runs before route authentication. Resolve the actor through
  // the usual auth middleware before deciding a shared card's owner access.
  if (!c.get("user") && (isInstallationSharedWorld(worldId) || suffix === "link-language")) {
    const denied = await authMiddleware(c, async () => {});
    if (denied) return denied;
  }
  const userId = c.get("user")?.id;
  let locked = await isWorldEditLockedForUser(worldId, userId);
  if (!locked && match[1] === "worlds" && suffix === "link-language") {
    const body = await c.req.raw.clone().json().catch(() => null) as { targetWorldId?: unknown } | null;
    locked = typeof body?.targetWorldId === "string" && await isWorldEditLockedForUser(body.targetWorldId, userId);
  }
  if (locked) return c.json({ error: LOCK_ERROR, code: "WORLD_EDIT_LOCKED" }, 403);
  return next();
};
