import assert from "node:assert/strict";
import test from "node:test";
import { aiConfigSchema, DEFAULT_MODEL_FALLBACK_POLICY, modelFallbackText, PLAY_MODELS } from "@yumina/shared";
import { fallbackDecision, fallbackRecord, parseFallbackError } from "./model-fallback";

test("existing users ask by default; automatic retries stop after one backup", () => {
  assert.equal(fallbackDecision(undefined, "official", null, "hermes", false).autoRetry, false);
  const auto = { ...DEFAULT_MODEL_FALLBACK_POLICY, mode: "auto" as const };
  assert.equal(fallbackDecision(auto, "official", null, "hermes", false).autoRetry, true);
  assert.equal(fallbackDecision(auto, "official", null, "hermes", true).autoRetry, false);
  assert.equal(fallbackDecision(auto, "official", null, auto.officialModel, false).autoRetry, false);
  assert.equal(fallbackDecision({ ...auto, mode: "stop" }, "official", null, "hermes", false).status, "stopped");
});

test("the saved backup profile can differ from the active key, including an inherited primary", () => {
  const policy = { ...DEFAULT_MODEL_FALLBACK_POLICY, mode: "auto" as const, privateModel: "backup", privateKeyId: "key1" };
  assert.equal(fallbackDecision(policy, "private", "key1", "original", false).autoRetry, true);
  assert.equal(fallbackDecision(policy, "private", "key2", "original", false).autoRetry, true);
  assert.equal(fallbackDecision(policy, "private", null, "original", false).autoRetry, true);
  assert.equal(fallbackDecision(policy, "private", "key2", "original", false).suggestedKeyId, "key1");
  assert.equal(fallbackDecision(policy, "private", "key2", "original", true).autoRetry, false);
  assert.equal(fallbackDecision({ ...policy, privateKeyId: null }, "private", "key2", "original", false).autoRetry, false);
});

test("the same model on another profile is a valid backup and is recorded", () => {
  const policy = { ...DEFAULT_MODEL_FALLBACK_POLICY, mode: "auto" as const, privateModel: "same", privateKeyId: "backup" };
  assert.equal(fallbackDecision(policy, "private", "primary", "same", false).autoRetry, true);
  assert.equal(fallbackDecision(policy, "private", "backup", "same", false).autoRetry, false);
  const retry = { requestedModel: "same", reason: "capacity" as const, automatic: true, attemptedFallback: true, providerChanged: true };
  assert.deepEqual(fallbackRecord(retry, "same"), { requestedModel: "same", reason: "capacity", automatic: true, providerChanged: true });
});

test("the synced preference is validated as an atomic policy", () => {
  assert.equal(aiConfigSchema.safeParse({ modelFallback: DEFAULT_MODEL_FALLBACK_POLICY }).success, true);
  assert.equal(aiConfigSchema.safeParse({ modelFallback: { mode: "auto" } }).success, false);
  assert.equal(aiConfigSchema.safeParse({ modelFallback: { ...DEFAULT_MODEL_FALLBACK_POLICY, mode: "whatever" } }).success, false);
});

test("only structured server errors open consent; ordinary failures do not", () => {
  assert.equal(parseFallbackError("network unavailable"), null);
  assert.equal(parseFallbackError(JSON.stringify({ code: "NO_CREDITS", error: "balance" })), null);
  const payload = { code: "MODEL_FALLBACK_REQUIRED", fallback: { requestedModel: "hermes", reason: "unavailable", provider: "official" }, userMessageId: "user1" };
  assert.equal(parseFallbackError(JSON.stringify(payload))?.userMessageId, "user1");
  assert.equal(parseFallbackError(JSON.stringify({ ...payload, fallback: { ...payload.fallback, reason: "invented" } })), null);
});

test("retrying the original model does not falsely label a reply as a backup", () => {
  const retry = { requestedModel: "hermes", reason: "unavailable" as const, automatic: false, attemptedFallback: false };
  assert.equal(fallbackRecord(retry, "hermes"), undefined);
  assert.deepEqual(fallbackRecord(retry, "gemini"), { requestedModel: "hermes", reason: "unavailable", automatic: false });
});

test("all supported locales explain consent and automatic switching", () => {
  for (const lang of ["en", "zh", "zh-Hant", "ja", "es"]) {
    assert.ok(modelFallbackText(lang, "title", { model: "Hermes" }).includes("Hermes"));
    assert.notEqual(modelFallbackText(lang, "once"), modelFallbackText(lang, "save"));
    assert.ok(!modelFallbackText(lang, "autoRecord", { model: "Hermes" }).includes("{{"));
  }
});


test("default backup is selectable in the play catalog on every plan", () => {
  const model = PLAY_MODELS.find((m) => m.id === DEFAULT_MODEL_FALLBACK_POLICY.officialModel);
  assert.ok(model);
  assert.equal(model.minPlan, "free");
});
