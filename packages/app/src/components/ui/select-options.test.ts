import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, Fragment } from "react";
import { selectOptionsFromChildren } from "./select-options";

test("declarative choices retain empty and numeric values, labels and conditional lists", () => {
  const choices = selectOptionsFromChildren(h(Fragment, null,
    h("option", { value: "" }, "All saves"),
    false,
    [h("option", { value: 0 }, "Zero"), h("option", { value: "id-a", label: "Readable name" }, "Raw ID")],
  ));
  assert.deepEqual(choices.map(({ value, label }) => [value, label]), [
    ["", "All saves"], ["0", "Zero"], ["id-a", "Readable name"],
  ]);
});

test("hidden choices stay hidden and disabled groups and options stay unavailable", () => {
  const choices = selectOptionsFromChildren([
    h("option", { value: "hidden", hidden: true }, "Hidden"),
    h("optgroup", { label: "Local", disabled: true }, h("option", { value: "anima" }, "Anima")),
    h("optgroup", { label: "Cloud" }, h("option", { value: "codex", disabled: true }, "Codex")),
  ]);
  assert.deepEqual(choices.map(({ value, group, disabled }) => ({ value, group, disabled })), [
    { value: "anima", group: "Local", disabled: true },
    { value: "codex", group: "Cloud", disabled: true },
  ]);
});
