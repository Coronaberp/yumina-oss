import { Hono, type MiddlewareHandler } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import type { EmbeddingProfile } from "../memory/types.js";
import type { StoryhavenProfileInput } from "@yumina/shared";
import {
  parseEmbeddingProfileInput,
  publicEmbeddingProfile,
} from "../memory/profile-input.js";

export interface MemoryProfileRoutesDependencies {
  repository: {
    list(userId: string): Promise<EmbeddingProfile[]>;
    getActive?(userId: string): Promise<EmbeddingProfile | null>;
    get(userId: string, id: string): Promise<EmbeddingProfile | null>;
    getCredential(userId: string, id: string): Promise<string>;
    create(
      userId: string,
      input: StoryhavenProfileInput,
    ): Promise<EmbeddingProfile>;
    updateKey(userId: string, id: string, key: string): Promise<void>;
  };
  prepare(profile: EmbeddingProfile): Promise<void>;
  test(profile: EmbeddingProfile): Promise<void>;
  activate(profile: EmbeddingProfile): Promise<void>;
  updateAdminDefault?(profile: EmbeddingProfile): Promise<EmbeddingProfile>;
}

export function createMemoryProfileRoutes(
  deps: MemoryProfileRoutesDependencies,
  authentication: MiddlewareHandler<AppEnv> = authMiddleware,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("/*", authentication);
  const dto = async (p: EmbeddingProfile) =>
    publicEmbeddingProfile(
      p,
      !!(await deps.repository.getCredential(p.userId, p.id)),
    );
  routes.get("/", async (c) => {
    const effective = await deps.repository.getActive?.(c.get("user").id);
    const profiles = await deps.repository.list(c.get("user").id);
    return c.json({
      profiles: await Promise.all(
        profiles.map(p => dto(effective?.id === p.id ? effective
          : effective === null && p.inheritedFrom && p.active
            ? { ...p, active: false, status: "failed", errorCode: "embedding_unavailable" }
            : p)),
      ),
    });
  });
  routes.post("/", async (c) => {
    let input: StoryhavenProfileInput;
    try {
      input = parseEmbeddingProfileInput(await c.req.json());
    } catch {
      return c.json({ error: "Invalid embedding profile configuration" }, 400);
    }
    const p = await deps.repository.create(c.get("user").id, input);
    await deps.prepare(p);
    return c.json({ profile: await dto(p) }, 201);
  });
  routes.put("/:id/key", async (c) => {
    const p = await deps.repository.get(c.get("user").id, c.req.param("id"));
    if (!p) return c.json({ error: "Profile not found" }, 404);
    if (p.inheritedFrom) return c.json({ error: "The administrator manages this embedding connection. Create a personal profile to override it." }, 403);
    let key: unknown;
    try {
      key = (await c.req.json()).apiKey;
    } catch {
      return c.json({ error: "Invalid key" }, 400);
    }
    if (typeof key !== "string" || key.length > 8192 || /[\r\n]/.test(key))
      return c.json({ error: "Invalid key" }, 400);
    await deps.repository.updateKey(p.userId, p.id, key);
    return c.json({ profile: await dto(p) });
  });
  for (const action of ["test", "activate", "reindex"] as const)
    routes.post(`/:id/${action}`, async (c) => {
      const p = await deps.repository.get(c.get("user").id, c.req.param("id"));
      if (!p) return c.json({ error: "Profile not found" }, 404);
      if (p.inheritedFrom && action === "activate")
        return c.json({ error: "Use reindex to update the admin embedding default." }, 400);
      try {
        if (action === "test") await deps.test(p);
        else if (p.inheritedFrom && deps.updateAdminDefault) {
          const updated = await deps.updateAdminDefault(p);
          return c.json({ profile: await dto(updated) });
        }
        else await deps.activate(p);
        const refreshed = await deps.repository.get(p.userId, p.id);
        return c.json({ profile: await dto(refreshed ?? p) });
      } catch {
        return c.json(
          {
            error:
              action === "test"
                ? "Embedding connection test failed"
                : "Profile migration or activation failed",
          },
          409,
        );
      }
    });
  return routes;
}
