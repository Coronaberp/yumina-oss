import assert from "node:assert/strict";
import test from "node:test";
import { slimMessages } from "./slim-messages";
import { validationRecords } from "../../../sandbox/extensions/state-update-guard/audit-records";
import type { StateValidationAudit } from "@yumina/shared";

const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  role: "assistant",
  content: "active body",
  stateSnapshot: { variables: { hp: 10 } }, // message-level — must survive
  activeSwipeIndex: 1,
  swipes: [
    { content: "swipe0", rawContent: "raw0", stateSnapshot: { variables: { hp: 9 } }, model: "x", creditCost: 1 },
    { content: "swipe1", rawContent: "raw1", stateSnapshot: { variables: { hp: 10 } }, model: "x", creditCost: 2 },
    { content: "swipe2", rawContent: "raw2", stateSnapshot: { variables: { hp: 11 } }, model: "x", creditCost: 3 },
  ],
  ...over,
});

test("saved assistant metadata cannot become a final VN page, while original raw output remains intact", () => {
  const content = 'The clerk waits.\n<variable-updates>\n\n</variable-updates>';
  const rawContent = 'The clerk waits.\n<variable-updates>\n[time-period: set "9:10 AM"]\n</variable-updates>';
  const original = msg({ content, activeSwipeIndex: 0, swipes: [{ content, rawContent }] });
  const [out] = slimMessages([original]);
  assert.equal(out.content, "The clerk waits.");
  const swipe = (out.swipes as Array<Record<string, unknown>>)[0]!;
  assert.equal(swipe.content, "The clerk waits.");
  assert.equal(swipe.rawContent, rawContent);
  assert.equal(original.content, content);
  assert.equal(original.swipes[0]!.content, content);
  const user = { role: "user", content };
  assert.equal(slimMessages([user])[0], user);
});

test("malformed yield receipts never enter a saved VN dialogue log, with original raw output retained", () => {
  const content = '*Lupe listens.*\n\n<yield>yumina-state version="1" status="updated" count="4"</yield>';
  const original = msg({ content, activeSwipeIndex: 0, swipes: [{ content, rawContent: content }] });
  const [out] = slimMessages([original]);
  assert.equal(out.content, '*Lupe listens.*');
  const swipe = (out.swipes as Array<Record<string, unknown>>)[0]!;
  assert.equal(swipe.content, '*Lupe listens.*');
  assert.equal(swipe.rawContent, content);
  assert.equal(original.content, content);
  const player = { role: 'user', content };
  assert.equal(slimMessages([player])[0], player);
});

test("slimMessages keeps message-level stateSnapshot (renderers + compacted display read it)", () => {
  const [out] = slimMessages([msg()]);
  assert.deepEqual(out.stateSnapshot, { variables: { hp: 10 } });
});

test("slimMessages drops swipe-level stateSnapshot from every swipe", () => {
  const [out] = slimMessages([msg()]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  for (const s of swipes) assert.equal("stateSnapshot" in s, false);
});

test("slimMessages keeps the active swipe's content + rawContent, drops them on non-active swipes", () => {
  const [out] = slimMessages([msg({ activeSwipeIndex: 1 })]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  // active (index 1) keeps content + rawContent
  assert.equal(swipes[1]!.content, "swipe1");
  assert.equal(swipes[1]!.rawContent, "raw1");
  // non-active drop content + rawContent
  assert.equal("content" in swipes[0]!, false);
  assert.equal("rawContent" in swipes[0]!, false);
  assert.equal("content" in swipes[2]!, false);
  assert.equal("rawContent" in swipes[2]!, false);
});

test("slimMessages preserves swipe count + scalar fields (for the N/M control)", () => {
  const [out] = slimMessages([msg()]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes.length, 3); // count drives "2/3"
  assert.equal(swipes[0]!.model, "x"); // scalars kept
  assert.equal(swipes[0]!.creditCost, 1);
});

test("server-owned content flags retain their source binding across the sandbox bridge", () => {
  const audit = { status: "complete", sourceHash: "original-source", label: "sfw" };
  const original = msg({ contentFlags: audit, swipes: [{ content: "active", contentFlags: audit }, { content: "inactive", contentFlags: { ...audit, label: "nsfw" } }], activeSwipeIndex: 0 });
  const [out] = slimMessages([original]);
  assert.deepEqual(out.contentFlags, audit);
  assert.deepEqual((out.swipes as Array<Record<string, unknown>>)[0]!.contentFlags, audit);
  assert.equal(((out.swipes as Array<Record<string, unknown>>)[1]!.contentFlags as typeof audit).label, "nsfw");
});

test("saved reasoning follows the active swipe without copying every trace into the iframe", () => {
  const original = msg({ swipes: [
    { content: "old", reasoningContent: "earlier thinking" },
    { content: "current", reasoningContent: "current thinking" },
  ] });
  const [out] = slimMessages([original]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes[1]!.reasoningContent, "current thinking");
  assert.equal(swipes[0]!.reasoningContent, undefined);
  assert.equal((original.swipes as Array<Record<string, unknown>>)[0]!.reasoningContent, "earlier thinking");
});

test("slimMessages defaults activeSwipeIndex to 0 when absent", () => {
  const m = msg({ activeSwipeIndex: undefined });
  delete (m as Record<string, unknown>).activeSwipeIndex;
  const [out] = slimMessages([m]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes[0]!.content, "swipe0"); // index 0 treated as active
  assert.equal("content" in swipes[1]!, false);
});

test("slimMessages returns the SAME array ref when no message has swipes (memo stability)", () => {
  const input = [{ id: "u1", role: "user", content: "hi" }];
  assert.equal(slimMessages(input), input);
});

test("slimMessages leaves a swipe-free message object untouched", () => {
  const input = [{ id: "u1", role: "user", content: "hi", stateSnapshot: { variables: {} } }];
  const [out] = slimMessages(input);
  assert.equal(out, input[0]); // same ref
});

test("non-active swipe audit keeps its own original after display bodies are removed", () => {
  const audit: StateValidationAudit = { version: 1, attemptId: "older", path: "regenerate", outcome: "valid-updates",
    diagnostics: [], parsedCount: 1, repaired: true, correctionCount: 1, model: "story", apiKeyTier: "byok",
    startedAt: "2026-09-09T01:00:00Z", baselineFingerprint: "baseline", usageLogIds: [] };
  const original = msg({ swipes: [
    { content: "old story", rawContent: "old original", stateValidation: audit, generationState: { privateBaseline: true } },
    { content: "new story", rawContent: "new original", stateValidation: { ...audit, attemptId: "newer" } },
  ] });
  const [out] = slimMessages([original], [{ id: "health", name: "Health" }]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes[0]!.rawContent, undefined);
  assert.equal(swipes[0]!.content, undefined);
  assert.equal(swipes[0]!.generationState, undefined);
  assert.equal((swipes[0]!.stateValidation as StateValidationAudit).originalRaw, "old original");
  assert.deepEqual(validationRecords([out]).map((item) => [item.attemptId, item.originalRaw]), [["older", "old original"], ["newer", "new original"]]);
  assert.deepEqual((swipes[0]!.stateValidation as StateValidationAudit).variableNames, { health: "Health" });
  assert.equal(audit.originalRaw, undefined, "source store audit must stay untouched");
  assert.equal((original.swipes as Array<Record<string, unknown>>)[0]!.rawContent, "old original");
});

test("message-only audit enrichment cannot take an active swipe's unrelated original", () => {
  const audit = { version: 1, attemptId: "message-attempt", path: "send" };
  const [out] = slimMessages([msg({ stateValidation: audit })], [{ id: "health", name: "Health" }]);
  assert.equal((out.stateValidation as StateValidationAudit).originalRaw, undefined);
  assert.deepEqual((out.stateValidation as StateValidationAudit).variableNames, { health: "Health" });
  assert.equal(Object.hasOwn(audit, "variableNames"), false);
});


test("choice handoff metadata is absent from VN and chat display while raw output and player text stay exact", () => {
  const content = '*The librarian waits.*\n\n<Yield>Choices follow</yield>';
  const original = msg({ content, activeSwipeIndex: 0, swipes: [{ content, rawContent: content }] });
  const [out] = slimMessages([original]);
  assert.equal(out.content, '*The librarian waits.*');
  assert.equal((out.swipes as Array<Record<string, unknown>>)[0]!.content, '*The librarian waits.*');
  assert.equal((out.swipes as Array<Record<string, unknown>>)[0]!.rawContent, content);
  assert.equal(original.content, content);
  const user = { role: 'user', content };
  assert.equal(slimMessages([user])[0], user);
});


test("unknown angle tags cannot leak from old saved messages, while raw content remains intact", () => {
  const content = 'Before\n<Yunmina-state version="1" status="updated" count="3"/>\n<another-control>After</another-control>';
  const original = msg({ content, activeSwipeIndex: 0, swipes: [{ content, rawContent: content }] });
  const [out] = slimMessages([original]);
  assert.equal(out.content, 'Before\n\nAfter');
  assert.equal((out.swipes as Array<Record<string, unknown>>)[0]!.rawContent, content);
});
