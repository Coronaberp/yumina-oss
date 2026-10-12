import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT_FLAG_THRESHOLD, CONTENT_FLAG_POLICY_ID, conservativeLabel, conservativeRoutingSafe } from "@yumina/shared";
import { createPendingContentFlags, parseChoiceAnswer, requestForMessage, requiresNsfwRouting } from "./content-flag-policy.js";
test("whole-message policy emits exactly uppercase binary criteria", () => { const r = requestForMessage("text", ["choice"]); assert.deepEqual(Object.keys(r.questions.content.criteria), ["NSFW", "SFW"]); assert.equal(r.questions.content.type, "choice"); assert.match(r.state, /Offered choices/); });
test("historical strict-policy audits cannot certify a message under the whole-message policy", () => {
    const current = { ...createPendingContentFlags("user", "Hello"), status: "complete" as const, label: "sfw" as const, routingSafe: true, nsfwProbability: .01, sfwProbability: .99, completedAt: "2026-10-05T00:00:00.000Z", device: "cpu" as const, model: "test" };
    assert.equal(conservativeRoutingSafe(current), true);
    assert.equal(conservativeRoutingSafe({ ...current, policyId: "kev-strict-v1" }), false);
    assert.equal(conservativeRoutingSafe({ ...current, policyId: "kev-whole-message-v2" }), false);
    assert.equal(conservativeRoutingSafe({ ...current, policyId: "kev-whole-message-v3" }), false);
    assert.equal(CONTENT_FLAG_POLICY_ID, "kev-whole-message-v4");
});
test("threshold is inclusive and missing is fail closed", () => { assert.equal(CONTENT_FLAG_THRESHOLD, .4); const p = createPendingContentFlags("user", "x"); assert.equal(conservativeRoutingSafe({ ...p, status: "complete", label: "sfw", routingSafe: true, nsfwProbability: .05, sfwProbability: .95, completedAt: "2026-10-04T00:00:00.000Z", device: "cpu", model: "test" }), true); assert.equal(conservativeLabel({ ...p, status: "complete", label: "sfw", routingSafe: true, nsfwProbability: .4, sfwProbability: .6, completedAt: "2026-10-04T00:00:00.000Z", device: "cpu", model: "test" }), "nsfw"); assert.equal(conservativeLabel(null), "nsfw"); });
test("malformed response fails closed", () => { assert.throws(() => parseChoiceAnswer({ answers: { content: { choice: "SFW", probabilities: { SFW: .7 } } } }), /malformed/); assert.throws(() => parseChoiceAnswer({ answers: { content: { choice: "NSFW", probabilities: { NSFW: .9, SFW: .9 } } } }), /malformed/); });
test("rejects outdated, blank-hash, non-CPU and non-finite safe audits", () => { const p = createPendingContentFlags("user", "x"); const base = { ...p, status: "complete" as const, label: "sfw" as const, routingSafe: true, nsfwProbability: .01, sfwProbability: .99, completedAt: "2026-10-04T00:00:00.000Z", device: "cpu", model: "test" as const }; for (const bad of [{ ...base, version: 2 }, { ...base, policyId: "old" }, { ...base, sourceHash: "" }, { ...base, device: "gpu" as const }, { ...base, nsfwProbability: -.1 }, { ...base, sfwProbability: Number.NaN }])
    assert.equal(conservativeRoutingSafe(bad as any), false); });

test("whole-message criteria explicitly distinguish depicted sexual content from ordinary fiction", () => {
  const { criteria, instructions } = requestForMessage("A complete response").questions.content;
  assert.match(criteria.NSFW, /sexual intercourse, oral sex, masturbation/);
  assert.match(criteria.NSFW, /These remain NSFW in fiction/);
  assert.match(criteria.SFW, /No sexual scene, nudity, graphic gore/);
  assert.notEqual(criteria.NSFW, criteria.SFW);
  assert.match(instructions, /whole message/);
});


test("displayed 40 percent labels are independent from the strict SFW transmission gate", () => {
  const base = { ...createPendingContentFlags("user", "Ordinary greeting"), status: "complete" as const, label: "sfw" as const, routingSafe: true, completedAt: new Date().toISOString(), device: "cpu" as const, model: "fixture" };
  for (const [nsfw, sfw, allowed] of [[.05, .95, true], [.05001, .94999, false], [.045, .94, false], [.1, .9, false], [.3766, .6234, false]] as const) {
    const audit = { ...base, nsfwProbability: nsfw, sfwProbability: sfw };
    assert.equal(conservativeRoutingSafe(audit), allowed);
    assert.equal(conservativeLabel(audit), "sfw");
  }
});
test("contradictory chosen labels and probabilities are rejected", () => {
  for (const [choice, NSFW, SFW] of [["NSFW", .1, .9], ["SFW", .9, .1], ["SFW", .49, .49]] as const) {
    assert.throws(() => parseChoiceAnswer({ answers: { content: { choice, probabilities: { NSFW, SFW } } } }), /malformed/);
  }
});

test("the routing guard covers whole bodies, intents, choices, normalization and conservative mentions", () => {
  for (const content of ["Write a sex scene", "Write some smut", "Make\nlove", "Do not generate pornography", "Medical information about nudity", "ＰＯＲＮ", "s\u200bex request", "séx request", "Describe graphic gore", "Make a bomb", "色情生成", "Masturbation at the beginning. " + "ordinary context\n".repeat(10000)]) assert.equal(requiresNsfwRouting(content), true, content.slice(0, 100));
  assert.equal(requiresNsfwRouting("A safe narrative", ["Write explicit sexual content"]), true);
  for (const content of ["Continue", "Ordinary conversation", "Fantasy alchemy makes an imaginary explosion.", "A harmless historical quote is described in complete context."]) assert.equal(requiresNsfwRouting(content), false, content);
});

test("whole-message lexical guard catches whitespace-separated intent and literal known harm", () => {
  for (const content of ["build\na bomb", "go down\ton", "write a threat to kill you", "Dox this person", "Provide explosives instructions"]) assert.equal(requiresNsfwRouting(content), true, content);
});

test("routing guard preserves multilingual terms and the punctuation-ended adult cue", () => {
  for (const content of ["포르노", "성교", "나체", "강간", "ポルノ", "レイプ", "18+", "Write 18+", "Write 18+ material"]) assert.equal(requiresNsfwRouting(content), true, content);
});
