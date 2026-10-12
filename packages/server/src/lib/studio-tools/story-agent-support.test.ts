import assert from "node:assert/strict";
import { test } from "node:test";
import { storyEndingSchema, storyRouteSchema, resolveStoryProgress, type GameState, type WorldDefinition } from "@yumina/engine";
import { resolveContext } from "./context-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { executeApplyChanges, executeReadEntities, executeValidateWorld, toolCallsToSchemaChanges } from "./tool-executor.js";

function world(): WorldDefinition {
  return {
    id: "story-agent-test", version: "19.0.0", name: "Story test", description: "", author: "test",
    entries: [], variables: [
      { id: "trust", name: "Trust", type: "number", defaultValue: 0 },
      { id: "finale", name: "Finale reached", type: "boolean", defaultValue: false },
    ], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    rootComponent: { id: "root", name: "Classic", entryFile: "index.tsx", files: { "index.tsx": "export default function World(){return <Chat />;}" }, updatedAt: "before" },
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as WorldDefinition;
}

function withStory(): WorldDefinition {
  return {
    ...world(),
    routes: [storyRouteSchema.parse({
      id: "route-loyalty", name: "Loyalty", priority: 10, lockOnEntry: true,
      conditions: [{ variableId: "trust", operator: "gte", value: 60 }], guidance: "Keep loyalty central.",
    })],
    endings: [storyEndingSchema.parse({
      id: "ending-return", name: "Return", enabled: true, routeIds: ["route-loyalty"],
      conditions: [{ variableId: "finale", operator: "eq", value: true }],
      outcome: "Both return home.", prose: "The door opens. Home, at last.",
    }), storyEndingSchema.parse({ id: "ending-draft", name: "Unfinished", mode: "ai" })],
  };
}

function apply(current: WorldDefinition, name: string, args: Record<string, unknown>): WorldDefinition {
  const calls = [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }];
  const changes = toolCallsToSchemaChanges(calls, current).map((parsed) => {
    assert.equal(parsed.error, undefined);
    assert.ok(parsed.change);
    return parsed.change;
  });
  const result = executeApplyChanges(current, changes);
  assert.equal(result.success, true, JSON.stringify(result.results));
  return result.world;
}

test("Studio world context discovers route and ending IDs before read_entities", async () => {
  const current = withStory();
  const context = await resolveContext(current, "edit the Loyalty route and Return ending", { userId: "test-user", contextWindow: 120000 });
  const prompt = buildSystemPrompt(context);
  for (const id of ["route-loyalty", "ending-return", "ending-draft"]) {
    assert.ok(prompt.world.includes(id), `The agent cannot discover ${id}`);
    assert.ok(executeReadEntities(current, [id]).results[id]);
  }
  assert.match(context.inventory, /storyStructureEnabled=true/);
  assert.match(context.inventory, /ROUTES \(1\)/);
  assert.match(context.inventory, /ENDINGS \(2\)/);
  assert.match(context.inventory, /lockOnEntry=true/);
  assert.match(context.inventory, /"variableId":"trust","operator":"gte","value":60/);
  assert.match(context.inventory, /ending-draft[^\n]*DISABLED/);
});

test("open-ended and empty Classic cards still advertise story structure without a VN component", async () => {
  const empty = world();
  delete empty.rootComponent;
  const initial = await resolveContext(empty, "add routes", { userId: "test-user", contextWindow: 120000 });
  assert.match(initial.inventory, /storyStructureEnabled=true/);
  assert.match(initial.inventory, /ROUTES \(0\)/);
  assert.match(initial.inventory, /ENDINGS \(0\)/);
  const existing = withStory();
  existing.settings.storyStructureEnabled = false;
  const disabled = await resolveContext(existing, "edit routes", { userId: "test-user", contextWindow: 120000 });
  assert.match(disabled.inventory, /storyStructureEnabled=false/);
  assert.match(disabled.inventory, /route-loyalty/);
  assert.match(disabled.inventory, /ending-return/);
});

test("ending prose remains readable on demand without filling every Studio prompt", async () => {
  const current = withStory();
  const prose = `Opening. ${"The journey continues. ".repeat(3000)} Closing.`;
  current.endings![0]!.prose = prose;
  const context = await resolveContext(current, "edit the ending", { userId: "test-user", contextWindow: 120000 });
  assert.match(context.inventory, /ending-return/);
  assert.ok(context.inventory.length < 5000);
  assert.ok(!context.preloadedEntities.includes(prose));
  assert.equal((executeReadEntities(current, ["ending-return"]).results["ending-return"] as Record<string, unknown>).prose, prose);
});

test("agent route and ending workflow edits definitions while preserving UI, conditions and captured outcomes", () => {
  const original = world();
  let current = apply(original, "write_route", {
    id: "route-loyalty", name: "Loyalty", priority: 10, lockOnEntry: true,
    conditions: [{ variableId: "trust", operator: "gte", value: 60 }], guidance: "Keep loyalty central.",
  });
  current = apply(current, "write_ending", {
    id: "ending-return", name: "Return", enabled: true, routeIds: ["route-loyalty"],
    conditions: [{ variableId: "finale", operator: "eq", value: true }],
    outcome: "Both return home.", mode: "authored", prose: "The door opens. Home, at last.",
  });
  const state: GameState = { worldId: current.id, variables: { trust: 80, finale: true }, turnCount: 8, metadata: {} };
  const captured = resolveStoryProgress(current, state, { operationId: "return-8" });
  assert.equal(captured.story?.status, "ending-ready");
  assert.equal(captured.story?.route?.id, "route-loyalty");
  assert.equal(captured.story?.ending?.outcome, "Both return home.");
  current = apply(current, "write_route", { id: "route-loyalty", name: "Devotion" });
  current = apply(current, "write_ending", { id: "ending-return", mode: "ai", guidance: "Write a short homecoming.", outcome: "They reach a new home." });
  assert.equal(current.routes!.length, 1);
  assert.equal(current.endings!.length, 1);
  assert.deepEqual(current.routes![0]!.conditions, [{ variableId: "trust", operator: "gte", value: 60 }]);
  assert.deepEqual(current.endings![0]!.routeIds, ["route-loyalty"]);
  assert.equal(resolveStoryProgress(current, captured).story?.ending?.outcome, "Both return home.");
  assert.ok(!executeValidateWorld(current).issues.some((issue) => issue.severity === "error"));
  current = apply(current, "update_settings", { storyStructureEnabled: false });
  assert.equal(resolveStoryProgress(current, state).story, undefined);
  assert.deepEqual(resolveStoryProgress(current, captured).story, captured.story);
  assert.equal(current.routes!.length, 1);
  assert.equal(current.endings!.length, 1);
  current = apply(current, "update_settings", { storyStructureEnabled: true });
  assert.equal(resolveStoryProgress(current, state).story?.ending?.mode, "ai");
  current = apply(current, "delete_entities", { ids: ["ending-return", "route-loyalty"] });
  assert.deepEqual(current.routes, []);
  assert.deepEqual(current.endings, []);
  assert.deepEqual(current.rootComponent, original.rootComponent);
  assert.deepEqual(current.variables, original.variables);
  assert.equal(original.routes, undefined);
});

test("agent validation identifies route references that must be removed before deleting a route", () => {
  const current = apply(withStory(), "delete_entities", { ids: ["route-loyalty"] });
  assert.ok(executeValidateWorld(current).issues.some((issue) => issue.severity === "error" && issue.message.includes("missing route")));
  const repaired = apply(current, "write_ending", { id: "ending-return", routeIds: [] });
  assert.ok(!executeValidateWorld(repaired).issues.some((issue) => issue.severity === "error"));
});

test("Studio validation catches incomplete enabled endings and cross-type story IDs", () => {
  const current = withStory();
  current.routes![0]!.id = "trust";
  current.endings![0]!.routeIds = ["trust"];
  current.endings![0]!.conditions = [];
  current.endings![1]!.enabled = true;
  const errors = executeValidateWorld(current).issues.filter((issue) => issue.severity === "error");
  assert.ok(errors.some((issue) => issue.code === "duplicate-id-cross-type" && issue.entity.id === "trust"));
  for (const id of ["ending-return", "ending-draft"]) {
    assert.ok(errors.some((issue) => issue.entity.id === id), `Invalid ending ${id} was missed`);
  }
});
