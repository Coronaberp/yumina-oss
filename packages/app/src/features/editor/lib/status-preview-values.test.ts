import test from "node:test";
import assert from "node:assert/strict";
import type { Variable } from "@yumina/engine";
import {
  STATUS_PREVIEW_INPUT_LIMIT, clearStatusPreviewOverride, filterStatusPreviewVariables,
  formatStatusPreviewInput, parseStatusPreviewInput, setStatusPreviewOverride, statusPreviewValue, statusPreviewValues, statusPreviewRequirements, describeStatusPreviewRequirement,
} from "./status-preview-values";

const hp = { id: "hero-hp", name: "Health", type: "number", defaultValue: 100, min: 0, max: 100 } as Variable;
const text = { id: "hero.name", name: "Hero name", type: "string", defaultValue: "Hero" } as Variable;
const flag = { id: "ready", name: "Ready", type: "boolean", defaultValue: true } as Variable;
const bag = { id: "bag", name: "Bag", type: "json", defaultValue: { Potion: 2 } } as Variable;
const variables = [hp, text, flag, bag];

test("temporary values preserve zero, false, empty text and JSON null; clearing restores defaults", () => {
  const overrides = { [hp.id]: 0, [text.id]: "", [flag.id]: false, [bag.id]: null };
  assert.deepEqual(statusPreviewValues(variables, overrides), overrides);
  assert.deepEqual(statusPreviewValues(variables, {}), Object.fromEntries(variables.map(v => [v.id, v.defaultValue])));
  assert.equal(statusPreviewValue(bag, { bag: { Potion: 2 } }, overrides), null);
});

test("preview edits and reset never mutate definitions, nested defaults or earlier overrides", () => {
  const definitionsBefore = JSON.stringify(variables);
  const original = { bag: { Potion: 9 }, ready: false };
  const originalBefore = JSON.stringify(original);
  const changed = setStatusPreviewOverride(original, hp.id, 37);
  const reset = clearStatusPreviewOverride(changed, "ready");
  assert.equal(reset[hp.id], 37);
  assert.equal(Object.hasOwn(reset, "ready"), false);
  assert.equal(statusPreviewValues(variables, reset).ready, true);
  assert.equal(JSON.stringify(original), originalBefore);
  assert.equal(JSON.stringify(variables), definitionsBefore);
});

test("all variables are available, including internal and disabled; stale IDs are ignored", () => {
  const internal = { ...hp, id: "engine-state", name: "Engine bookkeeping", internal: true, enabled: false };
  assert.deepEqual(statusPreviewValues([internal], { "engine-state": 0, removed: 123 }), { "engine-state": 0 });
  assert.deepEqual(filterStatusPreviewVariables([hp, internal], "hidden internal disabled"), [internal]);
  assert.deepEqual(filterStatusPreviewVariables(variables, "  HERO.NAME string "), [text]);
  assert.equal(filterStatusPreviewVariables(variables, "no match").length, 0);
});

test("literal IDs and own properties prevent nested-path and prototype confusion", () => {
  const prototypeId = { ...text, id: "__proto__" };
  const inherited = Object.create({ [hp.id]: 5 });
  assert.equal(statusPreviewValues([hp], inherited)[hp.id], 100);
  const overrides = setStatusPreviewOverride({}, "__proto__", "literal");
  const values = statusPreviewValues([text, prototypeId], overrides);
  assert.equal(values["hero.name"], "Hero");
  assert.equal(values.__proto__, "literal");
  assert.equal(Object.getPrototypeOf(values), Object.prototype);
  assert.equal(Object.hasOwn(clearStatusPreviewOverride(overrides, "__proto__"), "__proto__"), false);
});

test("number input accepts finite decimals/exponents without clamping preview edge cases", () => {
  for (const [input, value] of [["0", 0], ["-12.5", -12.5], [" .5 ", .5], ["1e2", 100], ["200", 200]] as const) {
    assert.deepEqual(parseStatusPreviewInput("number", input), { ok: true, value });
  }
  for (const input of ["", " ", "NaN", "Infinity", "1e999", "0x10", "10px", "1e", "--2"]) {
    assert.equal(parseStatusPreviewInput("number", input).ok, false, input);
  }
});

test("boolean and text inputs preserve their types and exact text", () => {
  assert.deepEqual(parseStatusPreviewInput("boolean", "false"), { ok: true, value: false });
  assert.deepEqual(parseStatusPreviewInput("boolean", "true"), { ok: true, value: true });
  assert.equal(parseStatusPreviewInput("boolean", "0").ok, false);
  assert.deepEqual(parseStatusPreviewInput("string", "  "), { ok: true, value: "  " });
  assert.deepEqual(parseStatusPreviewInput("string", ""), { ok: true, value: "" });
});

test("JSON supports nested objects, lists and null; invalid drafts do not replace last valid override", () => {
  const good = parseStatusPreviewInput("json", '{"items":[0,false,null,""]}');
  assert.deepEqual(good, { ok: true, value: { items: [0, false, null, ""] } });
  assert.deepEqual(parseStatusPreviewInput("json", "null"), { ok: true, value: null });
  assert.deepEqual(parseStatusPreviewInput("json", "[]"), { ok: true, value: [] });
  const lastGood = { bag: { Potion: 2 } };
  const bad = parseStatusPreviewInput("json", '{"Potion":');
  const next = bad.ok ? setStatusPreviewOverride(lastGood, "bag", bad.value) : lastGood;
  assert.equal(bad.ok, false);
  assert.equal(next, lastGood);
});

test("bounded text/JSON inputs report errors without changing the valid value", () => {
  for (const type of ["string", "json"] as const) assert.equal(parseStatusPreviewInput(type, "x".repeat(STATUS_PREVIEW_INPUT_LIMIT + 1)).ok, false);
  assert.equal(parseStatusPreviewInput("string", "x".repeat(STATUS_PREVIEW_INPUT_LIMIT)).ok, true);
});

test("formatting preserves JSON null and false rather than replacing them with empty inputs", () => {
  assert.equal(formatStatusPreviewInput("json", null), "null");
  assert.equal(formatStatusPreviewInput("boolean", false), "false");
  assert.equal(formatStatusPreviewInput("number", 0), "0");
  assert.equal(formatStatusPreviewInput("string", ""), "");
  assert.equal(statusPreviewValue(hp, { [hp.id]: 75 }, {}), 75);
  assert.equal(statusPreviewValue(hp, {}, {}), 100);
});

const relationship = { id: "rel-blair-winters", name: "Blair relationship", type: "number", defaultValue: 0,
  activation: { mode: "conditions", conditionLogic: "all", conditions: [{ variableId: "social-evidence.met.blair-winters", operator: "eq", value: true }] },
} as Variable;
const evidence = { id: "social-evidence", name: "Meetings", type: "json", defaultValue: {
  met: { "blair-winters": false, william: true }, events: [{ eventId: "preserve" }],
} } as Variable;

test("relationship score alone stays literal; explicit required values reveal the character without mutating evidence", () => {
  const definitions = [relationship, evidence];
  const values = statusPreviewValues(definitions, { [relationship.id]: 200 });
  const before = JSON.stringify({ definitions, values });
  const requirements = statusPreviewRequirements(relationship, definitions, values);
  assert.equal(requirements.active, false);
  assert.equal(requirements.conditions[0]!.current, false);
  assert.deepEqual(requirements.overrides, { "social-evidence": { met: { "blair-winters": true, william: true }, events: [{ eventId: "preserve" }] } });
  const populated: Record<string, unknown> = { ...values, ...requirements.overrides };
  assert.equal(populated[relationship.id], 200);
  assert.equal(statusPreviewRequirements(relationship, definitions, populated).active, true);
  assert.equal(JSON.stringify({ definitions, values }), before);
});

test("required values preserve existing overrides and combine sibling JSON paths atomically", () => {
  const gated = { ...relationship, activation: { mode: "conditions", conditionLogic: "all", conditions: [
    { variableId: "social-evidence.met.blair-winters", operator: "eq", value: true },
    { variableId: "social-evidence.met.william", operator: "eq", value: false },
  ] } } as Variable;
  const values = statusPreviewValues([gated, evidence], { "social-evidence": { ...evidence.defaultValue as object, extra: "keep" } });
  assert.deepEqual(statusPreviewRequirements(gated, [gated, evidence], values).overrides,
    { "social-evidence": { ...values["social-evidence"] as object, met: { "blair-winters": true, william: false } } });
});

test("required values use exact dotted IDs before nested paths", () => {
  const literal = { ...flag, id: "social-evidence.met.blair-winters", defaultValue: false };
  const values = statusPreviewValues([relationship, evidence, literal]);
  assert.deepEqual(statusPreviewRequirements(relationship, [relationship, evidence, literal], values).overrides,
    { [literal.id]: true });
});

test("ambiguous, conflicting and non-literal conditions remain manual", () => {
  const condition = relationship.activation!.mode === "conditions" ? relationship.activation!.conditions[0]! : null;
  assert.ok(condition);
  for (const activation of [
    { mode: "conditions", conditionLogic: "any", conditions: [condition] },
    { mode: "conditions", conditionLogic: "all", conditions: [{ ...condition, operator: "gt", value: 0 }] },
    { mode: "conditions", conditionLogic: "all", conditions: [{ ...condition, valueRef: "ready" }] },
    { mode: "conditions", conditionLogic: "all", conditions: [condition, { ...condition, value: false }] },
    { mode: "conditions", conditionLogic: "all", conditions: [{ ...condition, variableId: relationship.id, value: 0 }] },
    { mode: "conditions", conditionLogic: "all", conditions: [{ ...condition, variableId: "missing.flag" }] },
    { mode: "conditions", conditionLogic: "all", conditions: [{ ...condition, variableId: "social-evidence", value: {} }] },
  ]) {
    const gated = { ...relationship, activation } as Variable;
    assert.equal(statusPreviewRequirements(gated, [gated, evidence], statusPreviewValues([gated, evidence], { [gated.id]: 200 })).overrides, null);
  }
});

test("required-value shortcut never traverses prototypes or invents JSON branches", () => {
  for (const path of ["social-evidence.__proto__.polluted", "social-evidence.constructor.prototype.polluted", "social-evidence.met.prototype", "social-evidence.missing.flag", "social-evidence.met.blair-winters.flag"]) {
    const gated = { ...relationship, activation: { mode: "conditions", conditionLogic: "all", conditions: [{ variableId: path, operator: "eq", value: true }] } } as Variable;
    assert.equal(statusPreviewRequirements(gated, [gated, evidence], statusPreviewValues([gated, evidence])).overrides, null);
  }
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("preview requirements explain meetings and ordinary conditions in plain language", () => {
  const definitions = [relationship, evidence, { ...text, id: "chapter", name: "Story chapter", defaultValue: "holder" }];
  const values = statusPreviewValues(definitions);
  const meeting = statusPreviewRequirements(relationship, definitions, values).conditions[0]!;
  assert.equal(describeStatusPreviewRequirement(meeting, definitions), "Blair Winters hasn’t been met in this preview.");
  for (const [operator, value, expected] of [
    ["eq", "cascade", "Story chapter needs to be “cascade”. It is currently “holder”."],
    ["neq", "holder", "Story chapter needs to be different from “holder”. It is currently “holder”."],
    ["contains", "cascade", "Story chapter needs to include “cascade”. It is currently “holder”."],
  ] as const) {
    const gated = { ...relationship, activation: { mode: "conditions", conditionLogic: "all", conditions: [{ variableId: "chapter", operator, value }] } } as Variable;
    assert.equal(describeStatusPreviewRequirement(statusPreviewRequirements(gated, definitions, values).conditions[0]!, definitions), expected);
  }
  assert.equal(describeStatusPreviewRequirement({ ...meeting, current: undefined }, definitions), "Mark Blair Winters as met to show this item.");
});
