import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProfileRoutes } from "./memory-profiles.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/types.js";
import type { StoryhavenEmbeddingProfile } from "@yumina/shared";
const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", { id: "alice" } as never);
  await next();
};

test("profiles reject another owner and redact credentials while accepting different dimensions", async () => {
  const calls: string[] = [];
  const profile = {
    id: "a",
    userId: "alice",
    schemaName: "shm_hidden",
    baseUrl: "http://localhost:9000",
    model: "m",
    dimensions: 3072,
    sendDimensions: false,
    status: "pending",
    revision: 2,
    active: false,
  } as const;
  const repository = {
    list: async (userId: string) => {
      calls.push(userId);
      return [profile];
    },
    get: async (userId: string, id: string) =>
      userId === "alice" && id === "a" ? profile : null,
    getCredential: async () => "secret",
    create: async (userId: string, input: unknown) => {
      calls.push(userId);
      return { ...profile, ...(input as object) };
    },
    updateKey: async () => {},
  };
  const app = createMemoryProfileRoutes(
    {
      repository,
      prepare: async () => {},
      test: async () => {},
      activate: async () => {},
    },
    auth,
  );
  const list = await app.request("/");
  assert.equal(list.status, 200);
  const body = await list.text();
  assert.equal(body.includes("secret"), false);
  assert.equal(body.includes("shm_hidden"), false);
  assert.equal(
    (await app.request("/foreign/test", { method: "POST" })).status,
    404,
  );
  assert.equal(
    (
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:9000",
          model: "m",
          dimensions: 3072,
        }),
      })
    ).status,
    201,
  );
  assert.ok(calls.every((c) => c === "alice"));
  assert.equal(
    (
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://localhost:9000",
          model: "m",
          dimensions: 0,
        }),
      })
    ).status,
    400,
  );
});

test("inherited defaults are materialized, redacted, and cannot replace the admin key", async () => {
  const profile = { id: "private-alice", userId: "alice", schemaName: "shm_hidden", baseUrl: "http://private-admin/v1",
    model: "shared", dimensions: 3, sendDimensions: false, status: "ready", revision: 1, active: true, inheritedFrom: "admin-private-id" } as const;
  let materialized = false;
  let available = true;
  const app = createMemoryProfileRoutes({
    repository: {
      getActive: async () => { materialized = true; return available ? profile : null; },
      list: async () => { assert.equal(materialized, true); return [profile]; },
      get: async (owner, id) => owner === "alice" && id === profile.id ? profile : null,
      getCredential: async () => "secret", create: async () => profile,
      updateKey: async () => { assert.fail("An inherited credential must not be replaced"); },
    }, prepare: async () => {}, test: async () => {}, activate: async () => { assert.fail("An inherited row must not bypass migration"); },
    updateAdminDefault: async () => profile,
  }, auth);
  const listed = await (await app.request("/")).text();
  assert.match(listed, /"configurationSource":"admin"/);
  for (const privateValue of ["secret", "private-admin", "admin-private-id", "shm_hidden"]) assert.equal(listed.includes(privateValue), false);
  assert.equal((await app.request(`/${profile.id}/key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "new" }) })).status, 403);
  assert.equal((await app.request(`/${profile.id}/activate`, { method: "POST" })).status, 400);
  assert.equal((await app.request(`/${profile.id}/reindex`, { method: "POST" })).status, 200);
  available = false;
  const withdrawn = (await (await app.request("/")).json() as { profiles: StoryhavenEmbeddingProfile[] }).profiles[0]!;
  assert.equal(withdrawn.active, false, "Settings must not claim a withdrawn admin connection is active");
  assert.equal(withdrawn.errorCode, "embedding_unavailable");
});
