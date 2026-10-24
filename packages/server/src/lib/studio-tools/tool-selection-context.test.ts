import "../../test/database-fixture.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveContext, type ResolvedContext } from "./context-resolver.js";
import { CORE_TOOL_NAMES, buildToolSelectionInstructions } from "./tool-catalog.js";
import { db } from "../../db/index.js";
after(async () => { if ("close" in db.$client && typeof db.$client.close === "function") await db.$client.close(); });
const resolved = { inventory: "world fixture", preloadedEntities: "", truncated: false } as ResolvedContext;

test("lean prompts load only selected manuals and retain source integrity", () => {
  const core = buildSystemPrompt(resolved, { contextWindow: 1_000_000, toolNames: [...CORE_TOOL_NAMES] }).static;
  assert.match(core, /request_tools/); assert.match(core, /Emit nothing if no tracked value changed/);
  assert.doesNotMatch(core, /<skill name="(?:entries|variables|tsx|front-ui|world-design|rules)">/);
  assert.doesNotMatch(core, /<asset-handling>|<chapters-eras-and-timelines>|<official-templates>/);
  const variable = buildSystemPrompt(resolved, { contextWindow: 1_000_000, toolNames: [...CORE_TOOL_NAMES, "write_variable"] }).static;
  assert.match(variable, /<skill name="variables">/); assert.doesNotMatch(variable, /<skill name="tsx">/);
  const legacy = buildSystemPrompt(resolved, { contextWindow: 1_000_000 }).static;
  assert.match(legacy, /<skill name="tsx">/); assert.ok(core.length < legacy.length / 2);
});

test("VN/content and interface guides preserve the runtime formats and meaningful validation", () => {
  const guide = buildToolSelectionInstructions([...CORE_TOOL_NAMES, "edit_vn_assets", "write_entry", "edit_custom_ui"]);
  assert.match(guide, /scene IDs/i); assert.match(guide, /\[SCENE:configured-id\]/);
  assert.match(guide, /arrival.only/i); assert.match(guide, /independent.*variable/i);
  assert.match(guide, /outside.*<variable-updates>/i); assert.match(guide, /mount/i);
  assert.match(guide, /validate_world/); assert.match(guide, /does not prove rendered visibility/);
});

test("core context omits image inventory but retains normal entity reads and legacy media defaults", async () => {
  const world = migrateWorldDefinition({ id: "context-fixture", version: "19.0.0", name: "Context", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  const lean = await resolveContext(world, "Explain this project", { userId: "fixture", thumbnailUrl: "private-working-portrait", includeAssetInventory: false, includeMediaInventory: false });
  assert.doesNotMatch(lean.inventory, /ASSET LIBRARY|CARD MEDIA|private-working-portrait/);
  assert.match(lean.inventory, /Context/);
  const legacy = await resolveContext(world, "Explain this project", { userId: "fixture", thumbnailUrl: "legacy-portrait" });
  assert.match(legacy.inventory, /CARD MEDIA/); assert.match(legacy.inventory, /legacy-portrait/);
});
