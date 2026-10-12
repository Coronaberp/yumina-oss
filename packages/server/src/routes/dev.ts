import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { auth } from "../lib/auth.js";
import { AUTH_MODE, IS_DEV, env } from "../lib/env.js";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";

const devRoutes = new Hono();

const DEV_EMAIL = "dev@yumina.local";
const DEV_PASSWORD = "devpassword123";
const DEV_NAME = "Dev User";

async function markEmailVerified(email: string) {
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.email, email));
}

function isLocalHelperAvailable(url: string) {
  if (AUTH_MODE === "multi-user") return false;
  if (IS_DEV || !env.DATABASE_URL) {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  }

  return false;
}

/**
 * POST /api/dev/auto-login
 * Creates a default dev account if it doesn't exist, then signs in.
 * Only available when NODE_ENV !== "production".
 */
devRoutes.post("/auto-login", async (c) => {
  if (!isLocalHelperAvailable(c.req.url)) {
    return c.json({ error: "Not available in production" }, 404);
  }

  try {
    // Try sign-in first
    let result = await auth.api.signInEmail({
      body: { email: DEV_EMAIL, password: DEV_PASSWORD },
    }).catch(() => null);

    if (result) {
      await markEmailVerified(DEV_EMAIL);
    }

    if (!result) {
      await markEmailVerified(DEV_EMAIL);
      result = await auth.api.signInEmail({
        body: { email: DEV_EMAIL, password: DEV_PASSWORD },
      }).catch(() => null);
    }

    if (!result) {
      // Create the account first
      await auth.api.signUpEmail({
        body: { name: DEV_NAME, email: DEV_EMAIL, password: DEV_PASSWORD },
      });
      await markEmailVerified(DEV_EMAIL);

      // Then sign in
      result = await auth.api.signInEmail({
        body: { email: DEV_EMAIL, password: DEV_PASSWORD },
      });
    }

    // Set session cookie via Better Auth's handler so the browser gets it
    const internalReq = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    });
    const res = await auth.handler(internalReq);
    await markEmailVerified(DEV_EMAIL);

    // Forward Set-Cookie headers
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        c.header("Set-Cookie", value, { append: true });
      }
    });

    const data = await res.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: "Auto-login failed", detail: err.message }, 500);
  }
});

export { devRoutes };
