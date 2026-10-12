import { statusWidgetV1Templates } from "../world/status-widget-v1-templates.js";
import { statusBuilderV1Templates } from "../world/status-builder-v1-templates.js";
import { statusScrollV1Templates } from "../world/status-split-pip-templates.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { migrateWorldDefinition } from "../migration/migrate-v1-to-v2.js";
import { legacyStatusTemplates } from "../world/legacy-status-templates.js";
import { statusTemplates } from "../world/status-templates.generated.js";
import { upgradeStatusWorld } from "../world/status-visualizations-upgrade.js";
import type { WorldDefinition } from "../types/index.js";

function world(version = "21.0.0"): WorldDefinition {
  return { id: "status", version, name: "Card", entries: [], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 80 }], customUI: [],
    rootComponent: { id: "root", name: "VN", entryFile: "index.tsx", updatedAt: "saved", compiled: { code: "old compiled", filesHash: "old", compilerVersion: 1 }, files: {
      ...legacyStatusTemplates, "index.tsx": "authored menu", "status-config.ts": 'export const statusConfig = {"fields":[]};', "sprites.ts": "authored art", "_bundles/hud/index.tsx": "overlay",
    } },
  } as unknown as WorldDefinition;
}

describe("shipped VN status compatibility", () => {
  it("saved sheets gain scroll-edge blur without changing authored layout or other focus actions", () => {
    const original = world();
    const entry = 'StatusSheet api={sceneApi}\nview.current?.querySelector(".vn-back")?.focus();\nview.current?.querySelector(".vn-menu-status")?.focus();\nview.current?.querySelector("textarea")?.focus();';
    original.rootComponent!.files = { ...original.rootComponent!.files, ...statusTemplates, ...statusScrollV1Templates,
      "index.tsx": entry, "status-layout.tsx": "authored custom design" };
    const upgraded = upgradeStatusWorld(original);
    expect(upgraded.rootComponent!.files["status-sheet.tsx"]).toBe(statusTemplates["status-sheet.tsx"]);
    expect(upgraded.rootComponent!.files["status-layout.tsx"]).toBe("authored custom design");
    expect(upgraded.rootComponent!.files["index.tsx"]).toContain('querySelector(".vn-back")?.focus({ preventScroll: true })');
    expect(upgraded.rootComponent!.files["index.tsx"]).toContain('querySelector(".vn-menu-status")?.focus({ preventScroll: true })');
    expect(upgraded.rootComponent!.files["index.tsx"]).toContain('querySelector("textarea")?.focus();');
    expect(upgraded.rootComponent!.compiled).toBeUndefined();
    expect(upgradeStatusWorld(upgraded)).toBe(upgraded);
  });
  it("updates stock helpers and the stock sheet while preserving an authored status renderer", () => {
    const original = world();
    const authoredView = statusBuilderV1Templates["status-view.tsx"] + "\n// authored tab sizing";
    const layout = "export default function CustomStatus(){return <div>Relationships</div>}";
    original.rootComponent!.files = { ...original.rootComponent!.files, ...statusBuilderV1Templates,
      "status-view.tsx": authoredView, "status-layout.tsx": layout };
    const updated = upgradeStatusWorld(original);
    expect(updated.rootComponent!.files["status-data.ts"]).toBe(statusTemplates["status-data.ts"]);
    expect(updated.rootComponent!.files["status-widgets.tsx"]).toBe(statusTemplates["status-widgets.tsx"]);
    expect(updated.rootComponent!.files["status-view.tsx"]).toBe(authoredView);
    expect(updated.rootComponent!.files["status-layout.tsx"]).toBe(layout);
    expect(updated.rootComponent!.files["status-sheet.tsx"]).toBe(statusTemplates["status-sheet.tsx"]);
    expect(updated.rootComponent!.files["status-sheet.tsx"]).not.toContain('import { statusStyles }');
    expect(upgradeStatusWorld(updated)).toBe(updated);
  });
  it("cards with the earlier animated widgets gain custom categories without changing config", () => {
    const original = world();
    original.rootComponent!.files = { ...original.rootComponent!.files, ...statusWidgetV1Templates };
    const updated = upgradeStatusWorld(original);
    expect(updated.rootComponent!.files["status-data.ts"]).toBe(statusTemplates["status-data.ts"]);
    expect(updated.rootComponent!.files["status-view.tsx"]).toBe(statusTemplates["status-view.tsx"]);
    expect(updated.rootComponent!.files["status-config.ts"]).toBe(original.rootComponent!.files["status-config.ts"]);
    expect(updated.rootComponent!.compiled).toBeUndefined();
    expect(upgradeStatusWorld(updated)).toBe(updated);
  });
  it("every migrated schema version gives the agent the current renderer without changing card data", () => {
    for (const version of ["17.0.0", "18.0.0", "19.0.0", "20.0.0", "21.0.0"]) {
      const original = world(version); const current = migrateWorldDefinition(original);
      expect(current.rootComponent!.files["status-data.ts"]).toBe(statusTemplates["status-data.ts"]);
      expect(current.rootComponent!.files["status-widgets.tsx"]).toBe(statusTemplates["status-widgets.tsx"]);
      expect(current.rootComponent!.compiled).toBeUndefined();
      for (const name of ["status-config.ts", "sprites.ts", "index.tsx", "_bundles/hud/index.tsx"]) expect(current.rootComponent!.files[name]).toBe(original.rootComponent!.files[name]);
      expect(current.variables).toEqual(original.variables);
      expect(original.rootComponent!.files["status-data.ts"]).toBe(legacyStatusTemplates["status-data.ts"]);
    }
  });
  it("cached interfaces upgrade immutably while authored helpers remain untouched", () => {
    const original = world();
    const authored = { ...original.rootComponent!, files: { ...original.rootComponent!.files, "status-data.ts": "authored custom normalizer" } };
    original.interfaceDrafts = { vn: original.rootComponent!, custom: authored };
    const updated = upgradeStatusWorld(original);
    expect(updated.interfaceDrafts!.vn.files["status-gauge.tsx"]).toBe(statusTemplates["status-gauge.tsx"]);
    expect(updated.interfaceDrafts!.custom).toBe(authored);
    expect(original.interfaceDrafts.vn.files["status-gauge.tsx"]).toBeUndefined();
    expect(upgradeStatusWorld(updated)).toBe(updated);
  });
  it("historical snapshots preserve their original renderer and compiled source", () => {
    const original = world();
    const historical = migrateWorldDefinition(original, { preserveStatusSources: true });
    expect(historical.rootComponent!.files["status-data.ts"]).toBe(legacyStatusTemplates["status-data.ts"]);
    expect(historical.rootComponent!.compiled).toEqual(original.rootComponent!.compiled);
    expect(historical.rootComponent!.files["status-gauge.tsx"]).toBeUndefined();
  });
  it("old status sheets gain a separate custom layout without changing navigation or settings", () => {
    const original = world();
    const current = upgradeStatusWorld(original);
    expect(current.rootComponent!.files["status-layout.tsx"]).toContain("export default function StatusLayout");
    expect(current.rootComponent!.files["status-sheet.tsx"]).toContain('import StatusLayout from "./status-layout"');
    expect(current.rootComponent!.files["status-sheet.tsx"]).toContain("<StatusLayout config={statusConfig}");
    expect(current.rootComponent!.files["status-sheet.tsx"]).toContain("onClick={onBack}");
    expect(current.rootComponent!.files["status-config.ts"]).toBe(original.rootComponent!.files["status-config.ts"]);
    const custom = "export default function MyStatus(){return <div>Relationship compass</div>}";
    current.rootComponent!.files["status-layout.tsx"] = custom;
    expect(upgradeStatusWorld(current).rootComponent!.files["status-layout.tsx"]).toBe(custom);
  });
  it("packaged template sources match the canonical renderer files used by the editor preview", () => {
    for (const [name, source] of Object.entries(statusTemplates)) expect(source).toBe(readFileSync(new URL(`../../../../interfaces/vn/${name}`, import.meta.url), "utf8"));
  });
});
