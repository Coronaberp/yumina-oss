import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, session, account } from "../db/schema.js";
import { invalidateSessionUser } from "./session-user-cache.js";
import { redis } from "./redis.js";

/** Explicit server configuration pins the existing account; never promote a signup. */
export async function ensureLocalAdminAccount(accountId?: string, requireGitHubSignIn=false): Promise<void> {
  if (!accountId) return;
  const [owner] = await db.select({id:user.id,role:user.role}).from(user).where(eq(user.id,accountId));
  if (!owner) throw new Error("Configured local admin account does not exist");
  if (owner.role !== "admin") {
    await db.update(user).set({role:"admin",updatedAt:new Date()}).where(eq(user.id,accountId));
    await invalidateSessionUser(accountId);
  }
  if (requireGitHubSignIn) {
    const [linked]=await db.select({id:account.id}).from(account).where(and(eq(account.userId,accountId),eq(account.providerId,"github"))).limit(1);
    if (!linked) {
      const revoked=await db.delete(session).where(eq(session.userId,accountId)).returning();
      if (redis && revoked.length) {
        await redis.del(`ba:rl:active-sessions-${accountId}`,...revoked.flatMap(({token})=>[`session-v2:${token}`,`session:${token}`,`ba:rl:${token}`]));
      }
    }
  }
}

/** Only called with the profile ID obtained by Better Auth from GitHub's API. */
export async function adminIdentityForGitHub(profileId: unknown, config: {accountId?: string; githubId?: string}): Promise<{email?: string; emailVerified?: boolean}> {
  if (!config.accountId || !config.githubId || !/^\d+$/.test(String(profileId)) || String(profileId) !== config.githubId) return {};
  const [owner] = await db.select({email:user.email,role:user.role}).from(user).where(eq(user.id,config.accountId));
  return owner?.role === "admin" ? {email:owner.email,emailVerified:true} : {};
}
