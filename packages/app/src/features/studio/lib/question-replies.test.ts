import assert from "node:assert/strict";
import test from "node:test";
import * as chatTypes from "./types";
import type { StudioChatMessage } from "./types";

const question = (id: string): StudioChatMessage => ({
  id, role: "assistant", content: "What next?",
  questionPrompt: { question: "What next?", options: [{ label: "Just keep the image" }] },
});

test("folds only the first reply into its question while retaining saved agent history", () => {
  const messages: StudioChatMessage[] = [
    question("question-1"),
    { id: "trace", role: "assistant", content: "", activityTrace: { runId: "run", model: "Agent", items: [] } },
    { id: "reply-1", role: "user", content: "Just keep the image" },
    { id: "done", role: "assistant", content: "Kept it." },
    { id: "ordinary", role: "user", content: "Another request" },
  ];
  const saved = chatTypes.serializeStudioChatMessages(messages);
  const restored = JSON.parse(JSON.stringify(saved)) as StudioChatMessage[];
  const replies = chatTypes.getStudioQuestionReplies(restored);
  assert.deepEqual([...replies].map(([id, reply]) => [id, reply.id, reply.content]), [
    ["question-1", "reply-1", "Just keep the image"],
  ]);
  assert.deepEqual(restored, messages, "presentation must preserve every message used by the agent and undo");
});

test("a newer question owns the next reply instead of marking all older questions answered", () => {
  const replies = chatTypes.getStudioQuestionReplies([
    question("old"), question("current"),
    { id: "custom", role: "user", content: "Keep it for now\nName it later" },
  ]);
  assert.deepEqual([...replies].map(([id, reply]) => [id, reply.content]), [
    ["current", "Keep it for now\nName it later"],
  ]);
});

test("steering instructions do not become answers to an old question", () => {
  const replies = chatTypes.getStudioQuestionReplies([
    question("question"),
    { id: "steer", role: "user", content: "Stop and use another image", steering: { status: "applied", createdAt: "2026-10-13T00:00:00Z" } },
    { id: "next", role: "user", content: "A new task" },
  ]);
  assert.equal(replies.size, 0);
});
