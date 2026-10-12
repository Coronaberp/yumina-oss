import assert from "node:assert/strict";
import test from "node:test";
import { mergeStudioImageJobs } from "./image-job-state";

test("a missed drawing event restores a cancellable card and completion updates it once", () => {
  const card = { runId: "run", toolCallId: "image", jobId: "job", prompt: "Safe sprite", source: "codex", status: "generating" };
  const drawing = mergeStudioImageJobs([], [{ card }], "run");
  assert.equal(drawing.length, 1);assert.equal(drawing[0]!.imageProposal!.jobId, "job");
  assert.equal(mergeStudioImageJobs(drawing, [{ card }]).length, 1);
  const done = mergeStudioImageJobs(drawing, [{ card: { ...card, status: "done", assetIds: ["saved"] } }]);
  assert.equal(done.length, 1);assert.deepEqual(done[0]!.imageProposal!.assetIds, ["saved"]);
  assert.equal(done[0]!.id, drawing[0]!.id);
});

test("job recovery preserves transcript text and cancellation without inventing an approval", () => {
  const messages = [{ id: "user", role: "user" as const, content: "Draw a safe sprite" }];
  const merged = mergeStudioImageJobs(messages, [{ card: { runId: "run", toolCallId: "image", jobId: "job", prompt: "Safe sprite", status: "cancelled" } }], "run");
  assert.equal(merged[0], messages[0]);assert.equal(merged[1]!.imageProposal!.status, "cancelled");
  assert.equal(merged[1]!.proposalStatus, undefined);
  assert.equal(mergeStudioImageJobs(messages, [{ card: { status: "pending" } }]).length, 1);
});

test("ordinary refresh updates existing cards without resurrecting deleted or older cards", () => {
  const card = { runId: "deleted-run", toolCallId: "image", jobId: "old-job", prompt: "Safe sprite", status: "done" };
  assert.deepEqual(mergeStudioImageJobs([], [{ card }]), []);
  assert.deepEqual(mergeStudioImageJobs([], [{ card }], "active-run"), []);
  const visible = mergeStudioImageJobs([], [{ card: { ...card, status: "generating" } }], "deleted-run");
  const updated = mergeStudioImageJobs(visible, [{ card }]);
  assert.equal(updated.length, 1);assert.equal(updated[0]!.imageProposal!.status, "done");
});
