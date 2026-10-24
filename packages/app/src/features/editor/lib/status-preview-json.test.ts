import test from "node:test";
import assert from "node:assert/strict";
import { editStatusPreviewJson, emptyStatusPreviewJson } from "./status-preview-json";

test("form edits preserve siblings, literal keys, false/zero/blank/null and source objects", () => {
  const source = { met: { "blair-winters": false, sirius: true }, events: [{ reason: "keep" }], "literal.key": 0 };
  const before = JSON.stringify(source);
  const changed = editStatusPreviewJson(source, ["met", "blair-winters"], true);
  assert.deepEqual(changed, { ...source, met: { "blair-winters": true, sirius: true } });
  for (const value of [0, false, "", null]) assert.deepEqual(editStatusPreviewJson(source, ["literal.key"], value), { ...source, "literal.key": value });
  assert.equal(JSON.stringify(source), before);
});

test("empty objects and lists accept first entries; removing entries keeps a dense list", () => {
  assert.deepEqual(editStatusPreviewJson({}, ["first"], []), { first: [] });
  assert.deepEqual(editStatusPreviewJson([], [0], { name: "Blair" }), [{ name: "Blair" }]);
  assert.deepEqual(editStatusPreviewJson([0, false, ""], [1], null, true), [0, ""]);
  assert.deepEqual(editStatusPreviewJson({ keep: 1, remove: 2 }, ["remove"], null, true), { keep: 1 });
  assert.throws(() => editStatusPreviewJson([], [5], true));
  assert.throws(() => editStatusPreviewJson({ a: false }, ["a", "b"], true));
});

test("every JSON type has a form starting value, including primitive and null roots", () => {
  for (const [kind, value] of [["text", ""], ["number", 0], ["boolean", false], ["list", []], ["group", {}], ["empty", null]] as const) {
    assert.deepEqual(emptyStatusPreviewJson(kind), value);
    assert.deepEqual(editStatusPreviewJson({ old: true }, [], value), value);
  }
});

test("literal prototype-like fields never read inherited values or mutate prototypes", () => {
  const updated = editStatusPreviewJson({}, ["__proto__"], { polluted: true });
  assert.equal(Object.getPrototypeOf(updated), Object.prototype);
  assert.equal(Object.hasOwn(updated as object, "__proto__"), true);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.throws(() => editStatusPreviewJson({}, ["__proto__", "polluted"], true));
});
