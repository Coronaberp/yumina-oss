import test from "node:test";
import assert from "node:assert/strict";
import { migrateStudioPanelId, PANEL_MENU_GROUPS } from "../studio-page-catalog";

test("panel chooser uses current editor sections and omits legacy panels", () => {
  const items = PANEL_MENU_GROUPS.flatMap(group => [...group.items]);
  const ids = items.map(item => item.id as string);
  for (const id of ["custom-ui", "audio", "vn-sprites", "vn-backgrounds", "first-message", "lorebook", "variables", "rules", "overview"]) assert.ok(ids.includes(id));
  for (const id of ["assets", "code-view", "canvas", "sidebar"]) assert.ok(!ids.includes(id));
  assert.equal(items.find(item => item.id === "custom-ui")?.labelKey, "sections.customUI");
});
test("persisted single and split workspaces reopen current panels", () => {
  const saved = { activePanel: "code-view", topPanel: "canvas", bottomPanel: "assets" };
  assert.deepEqual(Object.fromEntries(Object.entries(saved).map(([slot, id]) => [slot, migrateStudioPanelId(id)])), { activePanel: "custom-ui", topPanel: "custom-ui", bottomPanel: "vn-sprites" });
  assert.equal(migrateStudioPanelId("ai-chat"), "ai-chat");
});
