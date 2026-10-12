import assert from "node:assert/strict";
import test from "node:test";
import { mergeStudioToolTrace, endStudioToolTrace } from "./tool-trace-state";
import { serializeStudioChatMessages } from "./types";

test("live requests become one completed trace group and persist without duplicate or downgraded rows", () => {
  const trace = { runId: "run", model: "codex/gpt-6-luna", items: [{ id: "read", kind: "read", title: "Read files", detail: "scenes.ts", status: "working" }] };
  const requested = mergeStudioToolTrace([], trace, true);assert.equal(requested.length, 1);
  const done = mergeStudioToolTrace(requested, { ...trace, items: [{ ...trace.items[0], status: "done", title: "Read" }] });
  const replay = mergeStudioToolTrace(done, trace);
  assert.equal(replay.length, 1);assert.equal(replay[0]!.activityTrace!.items.length, 1);assert.equal(replay[0]!.activityTrace!.items[0]!.status, "done");
  assert.deepEqual(serializeStudioChatMessages(replay)[0]!.activityTrace, replay[0]!.activityTrace);
  const unfinished = mergeStudioToolTrace(replay, { ...trace, items: [{ ...trace.items[0], id: "unconfirmed" }] });
  const ended = endStudioToolTrace(unfinished, "run");
  assert.equal(ended[0]!.activityTrace!.items[0]!.status, "done");assert.equal(ended[0]!.activityTrace!.items[1]!.title, "Outcome not received");
  assert.equal(ended[0]!.activityTrace!.items[1]!.status, "unconfirmed");
});

test("saved status updates existing traces without restoring a removed group unless rescuing that run", () => {
  const trace = { runId: "run", model: "codex/gpt-6-luna", items: [{ id: "image", kind: "image", title: "Opened image", detail: "hall.webp", status: "done", assetRef: "@asset:owned" }] };
  assert.deepEqual(mergeStudioToolTrace([], trace), []);
  const user = { id: "user", role: "user" as const, content: "Check backgrounds" };
  const rescued = mergeStudioToolTrace([user], trace, true);assert.equal(rescued[0], user);assert.equal(rescued[1]!.activityTrace!.items[0]!.assetRef, "@asset:owned");
  assert.equal(endStudioToolTrace(rescued, undefined), rescued);
  assert.equal(endStudioToolTrace(rescued, "run")[0], user);
  const invalid = mergeStudioToolTrace(rescued, { ...trace, items: [{ id: "invalid", status: "working", detail: "secret" }] });
  assert.equal(invalid[1]!.activityTrace!.items.length, 1);
});
