import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { createStudioTask, upsertTaskRequirements, evaluateStudioTask, observeStudioTask, studioTaskPrompt } from "./studio-task.js";

const world = () => ({ id: "w", entries: [{ id: "mei", name: "Mei", role: "custom", content: "A guide." }], variables: [], rules: [], chapters: [], rootComponent: { files: { "index.tsx": "export default function World(){return <Chat />;}" } } }) as unknown as WorldDefinition;
test("task checks read actual roles, values, files and validation, and cannot forge verification", () => {
  let task = createStudioTask("Create Mei as a character and use Chat", "work");
  task = upsertTaskRequirements(task, [{ id: "mei", text: "Mei is a character", checks: [{ kind: "entity", collection: "entries", id: "mei", field: "role", operator: "eq", value: "character" }] }, { id: "ui", text: "Use Chat", checks: [{ kind: "file", id: "index.tsx", operator: "contains", value: "<Chat />" }, { kind: "validation" }] }]);
  const card = world();
  let result = evaluateStudioTask(task, card, () => []);
  assert.equal(result.met, false); assert.deepEqual(result.requirements.map(r => r.verified), [false, true]);
  card.entries[0]!.role = "character";
  result = evaluateStudioTask(result, card, () => []);
  assert.equal(result.met, true);
  assert.equal(evaluateStudioTask(result, card, () => ["broken reference"]).met, false);
  card.rootComponent!.files["index.tsx"] = "export default function World(){return null;}";
  assert.equal(evaluateStudioTask(result, card, () => []).met, false, "saved proof must be rechecked");
  assert.equal(upsertTaskRequirements(task, [{ id: "x", text: "unchecked", verified: true, checks: [] }] as any).requirements.at(-1)!.verified, false);
});
test("requirements are append-only, original intent survives JSON restore and summaries", () => {
  let task = createStudioTask("Preserve all ten characters, {{user}}, and the greeting.", "work");
  task = upsertTaskRequirements(task, [{ id: "a", text: "Character roles", checks: [] }, { id: "b", text: "Greeting", checks: [] }]);
  task = upsertTaskRequirements(task, [{ id: "a", text: "Correct character roles", checks: [] }]);
  assert.equal(task.requirements.length, 2); assert.equal(task.goal.includes("{{user}}"), true);
  assert.match(studioTaskPrompt(JSON.parse(JSON.stringify(task))), /Greeting/);
  assert.equal(evaluateStudioTask(task, world(), () => []).met, false);
  assert.throws(() => upsertTaskRequirements(task, [{ id: "bad", text: "Unsafe", checks: [{ kind: "world", field: "__proto__.value", operator: "exists" }] }]));
});
test("new useful results and saved changes permit long work; repeated/cycling results recover then stall", () => {
  let task = createStudioTask("Read the project and fix it", "work");
  const card = world();
  for (let i = 0; i < 70; i++) {
    task = observeStudioTask(task, card, [{ result: `Distinct source slice ${i}` }]).task;
    assert.equal(task.status, "working");
  }
  let recoveries = 0;
  for (let i = 0; i < 14 && task.status !== "stalled"; i++) {
    const result = observeStudioTask(task, card, [{ checkedAt: Date.now(), result: "Distinct source slice 69" }]);
    task = result.task; if (result.recovery) recoveries++;
  }
  assert.equal(recoveries, 2); assert.equal(task.status, "stalled");
  task = createStudioTask("Change a value", "work");
  for (let i = 0; i < 15; i++) {
    card.entries[0]!.content = i % 2 ? "A" : "B";
    task = observeStudioTask(task, card, []).task;
  }
  assert.equal(task.status, "stalled", "cycling writes must not look like endless progress");
});
test("changed results on an identical request are progress and snapshots do not alias", () => {
  let task = createStudioTask("Inspect then repair", "work");
  const card = world();
  task = observeStudioTask(task, card, [{ tool: "read_entities", result: "old" }]).task;
  const before = structuredClone(task);
  const next = observeStudioTask(task, card, [{ tool: "read_entities", result: "new" }]);
  assert.equal(next.progress, true); assert.deepEqual(task, before);
});


test("exact value checks do not discard authored timestamp keys",()=>{
  const task=upsertTaskRequirements(createStudioTask("Keep the right date","work"),[{id:"date",text:"Keep the right date",checks:[{kind:"entity",collection:"entries",id:"mei",operator:"eq",value:{id:"mei",timestamp:"new"}}]}]);
  const card=world();card.entries=[{id:"mei",timestamp:"old"}] as any;
  assert.equal(evaluateStudioTask(task,card,()=>[]).met,false);
});
