import assert from "node:assert/strict";
import test from "node:test";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/types.js";
import { createStoryhavenMemoryRoutes } from "./storyhaven-memory.js";
const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", { id: "owner" } as never);
  await next();
};
test("full memory controls are authenticated, session scoped, and validate all mutations", async () => {
  const calls: unknown[] = [];
  const app = createStoryhavenMemoryRoutes(async (owner, sid) => {
    if (owner !== "owner" || sid !== "mine") return null;
    return {
      status: async () => ({ backend: "storyhaven" }),
      mutate: async (action, payload) => {
        calls.push([owner, sid, action, payload]);
        return { ok: true };
      },
    };
  }, auth);
  assert.equal((await app.request("/foreign/memory/storyhaven")).status, 404);
  assert.equal((await app.request("/mine/memory/storyhaven")).status, 200);
  assert.equal(
    (
      await app.request("/mine/memory/storyhaven/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: '{"backend":"invalid"}',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/mine/memory/storyhaven/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"id":"fact"}',
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, [["owner", "mine", "forget", { id: "fact" }]]);
  assert.equal(
    (
      await app.request("/mine/memory/storyhaven/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { memoryBudgetTokens: 1200, model: null },
        }),
      })
    ).status,
    200,
  );
  assert.deepEqual(calls[1], [
    "owner",
    "mine",
    "settings",
    { settings: { memoryBudgetTokens: 1200, model: null } },
  ]);
  const reset = await app.request("/mine/memory/storyhaven/settings", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { memoryBudgetTokens: null } }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(calls.at(-1), ["owner", "mine", "settings", { settings: { memoryBudgetTokens: null } }]);
  assert.equal(
    (
      await app.request("/mine/memory/storyhaven/fact", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: '{"id":"f","text":""}',
      })
    ).status,
    400,
  );
});
