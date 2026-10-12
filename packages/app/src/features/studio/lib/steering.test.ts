import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStudioSteering, studioTaskStart } from "./steering";
import { serializeStudioChatMessages, type StudioChatMessage } from "./types";

const item = { id: "steer-one", content: "Add rank", createdAt: "now", status: "queued" as const };
test("applied steering survives a late queued acknowledgement and retains one bubble", () => {
  const applied = mergeStudioSteering([], "run", [{ ...item, status: "applied", beforeIteration: 3 }]);
  const replayed = mergeStudioSteering(applied, "run", [item]);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]!.steering?.status, "applied");
  assert.deepEqual(serializeStudioChatMessages(replayed)[0]!.steering, { status: "applied", createdAt: "now", beforeIteration: 3 });
});
test("status recovery repairs ambiguous delivery failure and terminal rejection stays explicit", () => {
  const failed: StudioChatMessage = { id: item.id, content: item.content, role: "user", agentRunId: "run", steering: { status: "failed", createdAt: "now" } };
  const recovered = mergeStudioSteering([failed], "run", [item]);
  assert.equal(recovered[0]!.steering?.status, "queued");
  assert.equal(mergeStudioSteering(recovered, "run", [{ ...item, status: "failed" }])[0]!.steering?.status, "failed");
});
test("undo includes the original request when the latest message steered that run", () => {
  const messages: StudioChatMessage[] = [{ id: "old", role: "user", content: "Earlier turn" },
    { id: "old-answer", role: "assistant", content: "Earlier answer", agentRunId: "old-run" },
    { id: "original", role: "user", content: "Make widgets" },
    { id: "step", role: "assistant", content: "Working", agentRunId: "run" },
    ...mergeStudioSteering([], "run", [item])];
  assert.equal(studioTaskStart(messages, 4), 2);
  assert.equal(studioTaskStart(messages, 0), 0);
});
