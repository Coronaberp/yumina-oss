import assert from "node:assert/strict";
import { test } from "node:test";
import { chapterSchema, type WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, executeReadEntities, executeValidateWorld, toolCallsToSchemaChanges } from "./tool-executor.js";
import { resolveContext } from "./context-resolver.js";

test("chapter authoring tools preserve text and roles, expose native IDs, link books and clean deleted references", async () => {
  let world = { id: "chapter-tool-qa", name: "QA", version: "21.0.0", description: "", author: "QA", entries: [
    { id: "g", name: "Greeting", role: "greeting", content: "Authored opening", enabled: true, conditions: [], keywords: [] },
    { id: "npc", name: "Mei", role: "character", content: "Authored character", enabled: true, conditions: [], keywords: [] },
  ], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {}, worldbooks: [] } as unknown as WorldDefinition;
  function apply(name: string, args: Record<string, unknown>) {
    const calls = toolCallsToSchemaChanges([{ id: "call", function: { name, arguments: JSON.stringify(args) } }], world);
    assert.equal(calls[0]?.error, undefined); const result = executeApplyChanges(world, calls.map(call => call.change!));
    assert.equal(result.success, true, result.summary); world = result.world;
  }
  apply("write_chapter", { id: "origin", name: "Origin", greetingIds: ["g"] });
  apply("write_chapter", { id: "holder", name: "Holder" });
  apply("write_chapter", { id: "holder", events: [{ id: "clash", name: "Fated Clash", enabled: true, scenes: [{ id: "briefing", name: "Briefing", instructions: "Keep {{user}}'s choices open.", requiredMoments: [{ id: "mission", description: "Blair explains the mission." }], entryChanges: [{ entryId: "npc", enabled: true }] }] }] });
  apply("write_chapter", { id: "holder", date: "2280" });
  assert.equal(world.chapters?.[1]?.events?.[0]?.scenes[0]?.instructions, "Keep {{user}}'s choices open.");
  assert.equal((executeReadEntities(world, ["holder"]).results.holder as any).events[0].id, "clash");
  apply("write_chapter", { id: "origin", nextChapterIds: ["holder"] });
  apply("write_worldbook", { id: "cast", name: "Cast", chapterIds: ["holder"] });
  assert.deepEqual(world.chapters?.[0]?.greetingIds, ["g"]);
  assert.deepEqual(world.worldbooks?.[0]?.chapterIds, ["holder"]);
  assert.equal((executeReadEntities(world, ["origin"]).results.origin as any).name, "Origin");
  assert.equal((executeReadEntities(world, ["chapters"]).results.chapters as unknown[]).length, 2);
  assert.ok((await resolveContext(world, "edit chapter Holder", { userId: "qa", contextWindow: 120000 })).inventory.includes('"id":"holder"'));
  assert.ok(!executeValidateWorld(world, { skipTsx: true }).issues.some(issue => issue.code === "chapter-definition-invalid"));
  world.chapters!.push(chapterSchema.parse({ id: "bad", name: "Bad", greetingIds: ["missing"] }));
  assert.ok(executeValidateWorld(world, { skipTsx: true }).issues.some(issue => issue.code === "chapter-definition-invalid"));
  world.chapters = world.chapters!.filter(chapter => chapter.id !== "bad");
  const event = world.chapters![1]!.events![0]!;
  event.effects.push({ variableId: "missing", operation: "set", value: 1 });
  assert.ok(executeValidateWorld(world, { skipTsx: true }).issues.some(issue => issue.message.includes("effect variable missing")));
  event.effects = [];
  apply("delete_entities", { ids: ["holder"] });
  assert.deepEqual(world.chapters?.[0]?.nextChapterIds, []); assert.deepEqual(world.worldbooks?.[0]?.chapterIds, []);
  assert.equal(world.entries[0]!.content, "Authored opening"); assert.equal(world.entries[1]!.role, "character"); assert.equal(world.entries[1]!.content, "Authored character");
});
