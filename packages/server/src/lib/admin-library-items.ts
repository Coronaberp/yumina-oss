import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";

/** Separate display metadata for the admin's library; grants no world rights. */
export async function loadAdminLibraryItems(viewerId: string) {
  // Session user roles can be cached. Authorization must use the primary now.
  const [viewer] = await db.select({ role: user.role }).from(user)
    .where(eq(user.id, viewerId)).limit(1);
  if (viewer?.role !== "admin") {
    return { adminLibraryItems: [], adminLibraryViewerId: null };
  }

  // The temporary Seiryu display inclusion has been removed. Keep the response
  // shape compatible; ordinary owner listings and admin preview are separate.
  return {
    adminLibraryItems: [],
    adminLibraryViewerId: viewerId,
  };
}
