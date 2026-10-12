import assert from "node:assert/strict";
import test from "node:test";
import { findReplyRecoveryAnchor, hasReplyAfterAnchor } from "./reply-recovery";

const opening = { id: "opening", role: "assistant", content: "Welcome" };
const user = { id: "choice", role: "user", content: "Wait" };
const reply = { id: "reply", role: "assistant", content: "Here is the reply" };

test("a retry after reload adopts its existing user row even when it was already the tail", () => {
  const opts = { sentContent: "Wait", lastMessageIdAtSend: "choice", retryMessageId: "choice" };
  assert.equal(findReplyRecoveryAnchor([opening, user], opts), 1);
  assert.equal(findReplyRecoveryAnchor([opening, user, reply], opts), 1);
});

test("a missing retry row never adopts a different turn with identical text", () => {
  const opts = { sentContent: "Wait", lastMessageIdAtSend: "choice", retryMessageId: "choice" };
  assert.equal(findReplyRecoveryAnchor([opening, { ...user, id: "other" }, reply], opts), -1);
  assert.equal(findReplyRecoveryAnchor([{ ...user, role: "assistant" }], opts), -1);
});

test("fresh-send recovery ignores an identical choice from an earlier turn", () => {
  const opts = { sentContent: "Wait", lastMessageIdAtSend: "reply" };
  assert.equal(findReplyRecoveryAnchor([opening, user, reply], opts), -1);
  assert.equal(findReplyRecoveryAnchor([opening, user, reply, { ...user, id: "new" }], opts), 3);
  assert.equal(findReplyRecoveryAnchor([opening, user, reply, { ...user, id: "new", content: "Leave" }], opts), -1);
});

test("a reply belonging to a replacement choice never settles the original recovery", () => {
  assert.equal(hasReplyAfterAnchor([opening, user], 1), false);
  assert.equal(hasReplyAfterAnchor([opening, user, reply], 1), true);
  assert.equal(hasReplyAfterAnchor([opening, user, { ...user, id: "replacement" }, reply], 1), false);
  assert.equal(hasReplyAfterAnchor([opening, reply], -1), false);
});
