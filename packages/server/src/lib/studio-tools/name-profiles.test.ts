import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateWorldDefinition, worldSettingsSchema, type WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, executeReadEntities } from "./tool-executor.js";
import { resolveContext } from "./context-resolver.js";

test("creator naming profiles survive settings writes, schema validation and Studio discovery", async () => {
  const world = migrateWorldDefinition({ id: "profiles-test", version: "19.0.0", name: "Profiles", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  const profiles = [{ id: "northern-clan", label: "Northern clan", style: "nordic", format: "full", surname: "Frost", region: "North" }];
  const applied = executeApplyChanges(world, [{ action: "update", entityType: "settings", id: "settings", data: { nameGeneratorProfiles: profiles } }]);
  assert.equal(applied.success, true);
  assert.deepEqual(applied.world.settings.nameGeneratorProfiles, profiles);
  assert.deepEqual(worldSettingsSchema.parse(applied.world.settings).nameGeneratorProfiles, profiles);
  const read = executeReadEntities(applied.world, ["settings"]).results.settings as Record<string, unknown>;
  assert.deepEqual(read.nameGeneratorProfiles, profiles);
  const context = await resolveContext(applied.world, "Give names for the Northern clan", { userId: "test-user", contextWindow: 120000 });
  assert.match(context.inventory, /northern-clan/);
  const rejected = executeApplyChanges(applied.world, [{ action: "update", entityType: "settings", id: "settings", data: { nameGeneratorProfiles: [...profiles, ...profiles] } }]);
  assert.equal(rejected.success, false);
  assert.deepEqual(rejected.world.settings.nameGeneratorProfiles, profiles);
});
