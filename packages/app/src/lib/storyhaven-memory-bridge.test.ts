import assert from "node:assert/strict";
import test from "node:test";
import { storyhavenMemoryRequest } from "../../sandbox/protocol";

test("memory bridge rejects paths and inherited action names", () => {
  for (const action of ["../settings", "status/../../clear", "toString", "__proto__", null]) {
    assert.throws(() => storyhavenMemoryRequest(action), /Unsupported memory action/);
  }
});
test("memory bridge uses read-only status and explicit mutation bodies", () => {
  assert.deepEqual(storyhavenMemoryRequest("status", { unwanted: "ignored" }), { path: "", method: "GET" });
  assert.deepEqual(storyhavenMemoryRequest("fact", { id: "fact", pinned: true }), { path: "/fact", method: "PATCH", body: { id: "fact", pinned: true } });
  assert.deepEqual(storyhavenMemoryRequest("rebuild"), { path: "/rebuild", method: "POST", body: {} });
  for (const payload of [null, [], "bad"]) assert.throws(() => storyhavenMemoryRequest("preview", payload), /Invalid memory request/);
});
