import { env } from "./env.js";

/** Explicit local-installation examples; locking a private draft never shares it. */
export function installationSharedWorldIds(): string[] {
  if (env.YUMINA_EDITION !== "local") return [];
  return [...new Set((process.env.YUMINA_SHARED_WORLD_IDS ?? env.YUMINA_SHARED_WORLD_IDS)
    .split(/[\s,]+/).filter(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))];
}

export function isInstallationSharedWorld(id: string, status: string | null = "draft"): boolean {
  return (status === "draft" || status === "published") && installationSharedWorldIds().includes(id);
}
