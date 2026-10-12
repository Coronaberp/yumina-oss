import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createMemoryDatabase } from "./database.js";
import {
  createMemoryStartup,
  mountMemoryRoutes,
  mountMemoryHealth,
} from "./startup.js";
test("a stalled memory database cannot block app health or multiply outstanding probes", async () => {
  let queries = 0;
  const lifecycle = createMemoryStartup(
    {
      ensureAppTables: async () => {},
      getRuntime: async () => ({
        database: {
          query: () => {
            queries++;
            return new Promise(() => {});
          },
        } as never,
      }),
      startWorker: () => {},
      stopWorker: () => {},
      closeRuntime: async () => {},
    },
    { healthTimeoutMs: 25 },
  );
  await lifecycle.initialize();
  const app = new Hono();
  mountMemoryHealth(app, lifecycle);
  app.get("/health", (c) => c.json({ status: "ok" }));
  const response = await Promise.race([
    app.request("/health"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("health blocked")), 500),
    ),
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    memory: { status: "unavailable", errorCode: "memory_database_unavailable" },
  });
  await Promise.all([lifecycle.health(), lifecycle.health()]);
  assert.equal(queries, 1);
  await lifecycle.shutdown();
});
test("startup initializes app/store before worker and shuts worker down before closing store", async () => {
  const database = await createMemoryDatabase();
  let appReady = false,
    worker = false,
    closed = false;
  const lifecycle = createMemoryStartup({
    ensureAppTables: async () => {
      appReady = true;
    },
    getRuntime: async () => {
      assert.ok(appReady);
      return { database };
    },
    startWorker: () => {
      assert.ok(appReady);
      worker = true;
    },
    stopWorker: async () => {
      worker = false;
    },
    closeRuntime: async () => {
      assert.equal(worker, false);
      await database.close();
      closed = true;
    },
  });
  await Promise.all([lifecycle.initialize(), lifecycle.initialize()]);
  assert.ok(worker);
  assert.deepEqual(await lifecycle.health(), { status: "ready" });
  await lifecycle.shutdown();
  assert.ok(closed);
  assert.deepEqual(await lifecycle.health(), { status: "stopped" });
  await lifecycle.shutdown();
});
test("failed initialization remains separate from app health and redacts errors", async () => {
  const app = new Hono();
  const lifecycle = createMemoryStartup({
    ensureAppTables: async () => {
      throw new Error("postgres://secret@example/private");
    },
    getRuntime: async () => {
      throw new Error("not reached");
    },
    startWorker: () => {
      throw new Error("not reached");
    },
    stopWorker: async () => {},
    closeRuntime: async () => {},
  });
  mountMemoryHealth(app, lifecycle);
  app.get("/health", (c) => c.json({ status: "ok", database: "ready" }));
  await assert.rejects(() => lifecycle.initialize());
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: "ok",
    database: "ready",
    memory: {
      status: "unavailable",
      errorCode: "memory_initialization_failed",
    },
  });
  const details = await app.request("/health/memory");
  assert.equal(details.status, 503);
  assert.ok(!(await details.text()).includes("secret"));
  await lifecycle.shutdown();
});
test("StoryHaven APIs mount before the legacy extension gate at native client paths", async () => {
  const app = new Hono(),
    profiles = new Hono(),
    sessions = new Hono();
  profiles.get("/", (c) => c.json({ profiles: [] }));
  sessions.get("/:sessionId/memory/storyhaven", (c) =>
    c.json({ sessionId: c.req.param("sessionId") }),
  );
  mountMemoryRoutes(app, profiles, sessions);
  app.use("/api/sessions/:sessionId/memory/*", async (c) =>
    c.json({ error: "legacy extension disabled" }, 403),
  );
  assert.equal((await app.request("/api/memory/profiles")).status, 200);
  const session = await app.request("/api/sessions/one/memory/storyhaven");
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { sessionId: "one" });
  assert.equal(
    (await app.request("/api/sessions/one/memory/legacy")).status,
    403,
  );
});
test("shutdown during initialization never starts a new worker", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let workerStarts = 0,
    closed = false;
  const database = await createMemoryDatabase();
  const lifecycle = createMemoryStartup({
    ensureAppTables: async () => {
      entered();
      await blocked;
    },
    getRuntime: async () => ({ database }),
    startWorker: () => {
      workerStarts++;
    },
    stopWorker: async () => {},
    closeRuntime: async () => {
      await database.close();
      closed = true;
    },
  });
  const initializing = lifecycle.initialize();
  await ready;
  const stopping = lifecycle.shutdown();
  release();
  await initializing;
  await stopping;
  assert.equal(workerStarts, 0);
  assert.ok(closed);
  assert.deepEqual(await lifecycle.health(), { status: "stopped" });
});
test("worker initialization failures remain unavailable and a later initialization can recover", async () => {
  const database = await createMemoryDatabase();
  let fail = true;
  const lifecycle = createMemoryStartup({
    ensureAppTables: async () => {},
    getRuntime: async () => ({ database }),
    startWorker: () => {
      if (fail) throw new Error("worker startup");
    },
    stopWorker: async () => {},
    closeRuntime: async () => database.close(),
  });
  await assert.rejects(() => lifecycle.initialize());
  assert.deepEqual(await lifecycle.health(), {
    status: "unavailable",
    errorCode: "memory_initialization_failed",
  });
  fail = false;
  await lifecycle.initialize();
  assert.deepEqual(await lifecycle.health(), { status: "ready" });
  await lifecycle.shutdown();
});
