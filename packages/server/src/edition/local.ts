import type { Hono } from "hono";
import { AUTH_MODE, env } from "../lib/env.js";
import { storageKind } from "../lib/s3.js";
import type { Edition, EditionFeatures, EditionInfo, EditionName } from "./types.js";
import { resolveAuthenticationPolicy } from "../lib/authentication-policy.js";
import { localAdminRoutes } from "../routes/local-admin.js";
import { configuredImageJobs } from "../lib/configured-image-jobs.js";

/** Every platform feature off. This is the open-source edition. */
export const LOCAL_FEATURES: EditionFeatures = {
  hub: false,
  publishing: false,
  community: false,
  billing: false,
  officialModels: false,
  achievements: false,
  referrals: false,
  dm: false,
  notifications: false,
  reviews: false,
  bundles: false,
  extensions: true,
  multiplayer: false,
  imageGeneration: false,
  library: false,
  sharedPlaythroughs: false,
  socialProfiles: false,
  admin: true,
  telemetry: false,
};

export function configuredSocialProviders(): string[] {
  const out: string[] = [];
  if (env.YUMINA_SIGN_IN_METHOD !== "github" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  if (env.YUMINA_SIGN_IN_METHOD !== "github" && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) out.push("discord");
  if (env.YUMINA_SIGN_IN_METHOD !== "github" && env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET) out.push("twitter");
  return out;
}

export function releaseId(): string | null {
  return process.env.APP_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || null;
}

export function buildInfo(edition: EditionName, features: EditionFeatures): EditionInfo {
  return {
    edition,
    release: releaseId(),
    features,
    auth: resolveAuthenticationPolicy(AUTH_MODE, env.YUMINA_SIGN_IN_METHOD, Object.fromEntries(configuredSocialProviders().map(provider=>[provider,true]))),
    storage: { kind: storageKind() },
  };
}

export const localEdition: Edition = {
  name: "local",
  info: () => buildInfo("local", LOCAL_FEATURES),
  mountPublicApiRoutes(app: Hono) { app.route("/api/admin",localAdminRoutes); },
  mountApiRoutes(_app: Hono) {},
  mountRootRoutes(_app: Hono) {},
  startBackgroundJobs() { configuredImageJobs.start(); },
  stopBackgroundJobs() { configuredImageJobs.stop(); },
  async drain(timeoutMs: number) { await configuredImageJobs.drain(timeoutMs); },
  afterListen() {},
};
