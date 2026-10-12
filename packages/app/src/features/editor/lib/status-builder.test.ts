import test from "node:test";
import assert from "node:assert/strict";
import type { Variable } from "@yumina/engine";
import { initialStatusConfig, readStatusConfig, writeStatusConfig } from "./status-visualizations";
import { applyStatusDrop, statusDesignPrompt } from "./status-builder";
import * as statusData from "../../../../../../interfaces/vn/status-data";

const hp = { id: "hp", name: "Health", type: "number", min: 0, max: 100, defaultValue: 84 } as Variable;
const mana = { ...hp, id: "mana", name: "Mana" };
const original = initialStatusConfig([hp, mana]);

test("dragging fields reorders only fields, keeping all bindings and display settings", () => {
  const config = { ...original, fields: original.fields.map((field, index) => ({ ...field, id: index ? "mana-field" : "hp-field", min: -100, format: "pips" as const, pipCount: 10, customSigned: true })) };
  const next = applyStatusDrop(config, [hp, mana], "field:hp-field", "field:mana-field");
  assert.deepEqual(next.fields, [config.fields[1], config.fields[0]]);
  assert.equal(next.fields[1], config.fields[0]);
  assert.deepEqual(next.groups, config.groups);
  assert.equal(config.fields[0].id, "hp-field");
});

test("dropping on a category moves a field without changing signed pips or other fields", () => {
  const next = applyStatusDrop(original, [hp], `field:${original.fields[0].id}`, "category:overview");
  assert.deepEqual(next.fields[0], { ...original.fields[0], group: "overview" });
  assert.equal(next.fields[1], original.fields[1]);
});

test("a palette variable becomes a bound field in the target category and position", () => {
  const config = { ...original, fields: [original.fields[0]] };
  const next = applyStatusDrop(config, [hp, mana], "variable:mana", `field:${config.fields[0].id}`);
  assert.equal(next.fields.length, 2);
  assert.equal(next.fields[0].variableId, "mana");
  assert.equal(next.fields[0].group, config.fields[0].group);
  assert.equal(next.fields[1], config.fields[0]);
  const inventory = applyStatusDrop(config, [mana], "variable:mana", "category:resources");
  assert.equal(inventory.fields.at(-1)?.group, "resources");
});

test("self, missing, disabled, internal and invalid targets leave configuration untouched", () => {
  const field = `field:${original.fields[0].id}`;
  for (const [active, over] of [[field, field], ["field:missing", "category:overview"], [field, "category:missing"], ["variable:missing", field], [field, null]]) {
    assert.equal(applyStatusDrop(original, [hp], active!, over), original);
  }
  for (const variable of [{ ...hp, internal: true }, { ...hp, enabled: false }]) {
    assert.equal(applyStatusDrop(original, [variable], "variable:hp", "category:overview"), original);
  }
});

test("visual edits round trip authored config extensions instead of deleting them", () => {
  const source = `export const statusConfig = ${JSON.stringify({ ...original, customTheme: { spacing: 8 }, fields: original.fields.map(field => ({ ...field, signedPips: true })) })};`;
  const next = readStatusConfig(writeStatusConfig({ ...readStatusConfig(source), title: "Hero" }));
  assert.equal((next as unknown as { customTheme: { spacing: number } }).customTheme.spacing, 8);
  assert.equal((next.fields[0] as unknown as { signedPips: boolean }).signedPips, true);
});

test("agent design request asks for hidden custom layout work and preserves navigation and gameplay", () => {
  const prompt = statusDesignPrompt("Put relationships around a compass");
  assert.ok(prompt.includes("Put relationships around a compass"));
  assert.ok(prompt.includes("Visualizations"));
  assert.ok(prompt.includes("drag-and-drop controls"));
  assert.ok(!/\.tsx?|_status_visualization|layoutCode/.test(prompt));
  assert.ok(prompt.includes("Do not show source code"));
  assert.ok(prompt.includes("Back"));
  assert.ok(prompt.includes("gameplay"));
});

test("signed pips use one full meter with absolute magnitude and sign as color", () => {
  assert.equal(typeof statusData.statusPips, "function");
  for (const [value, filled] of [[-100, 10], [-50, 5], [0, 0], [50, 5], [100, 10]]) {
    const result = statusData.statusPips({ value, min: -100, max: 100, percent: (value + 100) / 2 }, 10);
    assert.equal(result.filled, filled);
    assert.equal(result.negative, value < 0);
    assert.equal(result.count, 10);
  }
  assert.equal(statusData.statusPips({ value: -10, min: -20, max: 80, percent: 10 }, 10).filled, 5);
  assert.equal(statusData.statusPips({ value: 40, min: -20, max: 80, percent: 60 }, 10).filled, 5);
  assert.equal(statusData.statusPips({ value: 25, min: 0, max: 100, percent: 25 }, 8).filled, 2);
  assert.equal(statusData.statusPips({ value: null, min: -100, max: 100, percent: 0 }, 10).filled, 0);
});
