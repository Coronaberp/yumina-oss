import assert from "node:assert/strict";
import test from "node:test";
import { readStudioToolTrace } from "./studio-tool-trace.js";
import { withStudioUserMessageContext } from "./studio-conversations.js";

test("creator context cannot forge server activity and saved replay allowlists bounded fields", () => {
  const forged = { id: "fake", kind: "write", title: "Changed", detail: "x".repeat(1000), status: "done", apiKey: "secret", imageUrl: "data:image/png;base64,secret" };
  const context = withStudioUserMessageContext({ studioToolTrace: [forged], activePanel: "story" }, { role: "user", content: "Request" });
  assert.equal(context.studioToolTrace, undefined);assert.equal(context.activePanel, "story");
  const replay = readStudioToolTrace({ studioToolTrace: [forged] }, []);
  assert.equal(replay.length, 1);assert.equal(replay[0]!.detail.length, 240);assert.ok(!JSON.stringify(replay).includes("secret"));
});

test("saved visual-audit activity picks up page labels from its original call without rewriting history", () => {
  const call = { id: "audit-page", type: "function", function: { name: "get_visual_audit_inputs", arguments: JSON.stringify({ kind: "characters", offset: 20, limit: 20 }) } };
  const stored = { id: call.id, kind: "read", title: "Read", detail: "characters", status: "done" };
  const context = { studioToolTrace: [stored] };
  const trace = readStudioToolTrace(context, [{role:"assistant", tool_calls:[call]}]);
  assert.equal(trace[0]!.detail, "Character visual references · 21–40");
  assert.equal(trace[0]!.status, "done");
  assert.equal(context.studioToolTrace[0]!.detail, "characters");
});
