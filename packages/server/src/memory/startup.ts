import type { Hono, Env } from "hono";
import type { MemoryDatabase } from "./types.js";
export interface MemoryStartupDependencies {
  ensureAppTables(): Promise<void>;
  getRuntime(): Promise<{ database: MemoryDatabase }>;
  startWorker(): void;
  stopWorker(): void | Promise<void>;
  closeRuntime(): Promise<void>;
}
export interface MemoryHealth {
  status: "initializing" | "ready" | "unavailable" | "stopping" | "stopped";
  errorCode?: "memory_initialization_failed" | "memory_database_unavailable";
}
export interface MemoryStartup {
  initialize(): Promise<void>;
  health(): Promise<MemoryHealth>;
  shutdown(): Promise<void>;
}
/** Memory availability is separate from ordinary chat and application health. */
export function createMemoryStartup(
  deps: MemoryStartupDependencies,
  options: { healthTimeoutMs?: number } = {},
): MemoryStartup {
  let phase: MemoryHealth["status"] = "initializing",
    initializing: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  let runtime: { database: MemoryDatabase } | undefined;
  let probe: Promise<boolean> | undefined;
  return {
    initialize() {
      if (closing) return Promise.reject(new Error("memory_stopping"));
      if (!initializing) phase = "initializing";
      return (initializing ??= (async () => {
        try {
          await deps.ensureAppTables();
          runtime = await deps.getRuntime();
          if (phase === "stopping" || phase === "stopped") return;
          deps.startWorker();
          phase = "ready";
        } catch (error) {
          if (phase !== "stopping" && phase !== "stopped")
            phase = "unavailable";
          initializing = undefined;
          throw error;
        }
      })());
    },
    async health() {
      if (phase === "stopping" || phase === "stopped") return { status: phase };
      if (phase === "unavailable")
        return { status: phase, errorCode: "memory_initialization_failed" };
      if (!runtime || phase === "initializing")
        return { status: "initializing" };
      // Keep one outstanding probe during an outage and bound the app response.
      if (!probe) {
        const current = runtime.database.query("SELECT 1").then(
          () => true,
          () => false,
        );
        probe = current;
        void current.finally(() => {
          if (probe === current) probe = undefined;
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const healthy = await Promise.race([
        probe,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            options.healthTimeoutMs ?? 1000,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      return healthy
        ? { status: "ready" }
        : { status: "unavailable", errorCode: "memory_database_unavailable" };
    },
    shutdown() {
      if (closing) return closing;
      phase = "stopping";
      return (closing = (async () => {
        const stopping = Promise.resolve().then(() => deps.stopWorker());
        const pending = initializing ?? Promise.resolve();
        const results = await Promise.allSettled([stopping, pending]);
        try {
          await deps.closeRuntime();
        } finally {
          phase = "stopped";
        }
        if (results[0]!.status === "rejected")
          throw new Error("memory_shutdown_failed");
      })());
    },
  };
}
export function mountMemoryRoutes<E extends Env, P extends Env, S extends Env>(
  app: Hono<E>,
  profiles: Hono<P>,
  sessions: Hono<S>,
): void {
  app.route("/api/memory/profiles", profiles);
  app.route("/api/sessions", sessions);
}
export function mountMemoryHealth<E extends Env>(
  app: Hono<E>,
  memory: MemoryStartup,
): void {
  app.use("/health", async (c, next) => {
    await next();
    const response = c.res;
    if (!response.headers.get("content-type")?.includes("application/json"))
      return;
    const body = await response.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    c.res = new Response(
      JSON.stringify({ ...body, memory: await memory.health() }),
      { status: response.status, statusText: response.statusText, headers },
    );
  });
  app.get("/health/memory", async (c) => {
    const status = await memory.health();
    return c.json(status, status.status === "ready" ? 200 : 503);
  });
}
