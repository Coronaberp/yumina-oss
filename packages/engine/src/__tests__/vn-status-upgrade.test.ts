import { statusWidgetV1Templates } from "../world/status-widget-v1-templates.js";
import { statusBuilderV1Templates } from "../world/status-builder-v1-templates.js";
import { statusScrollV1Templates } from "../world/status-split-pip-templates.js";
import { statusEncounterV0Templates } from "../world/status-encounter-v0-templates.js";
import { statusTabsV1Templates } from "../world/status-tabs-v1-templates.js";
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
  it.each(['status-data.ts', 'status-gauge.tsx', 'status-widgets.tsx'])(
    'updates the recognized tab sheet independently of authored %s', (customHelper) => {
      const original = world();
      original.rootComponent!.files = { ...statusTemplates, ...statusTabsV1Templates,
        [customHelper]: statusTemplates[customHelper] + '\n// authored helper',
        'status-layout.tsx': 'authored layout', 'status-config.ts': 'authored settings',
        'index.tsx': 'StatusSheet api={sceneApi}\nview.current?.querySelector(".vn-back")?.focus();\nview.current?.querySelector(".vn-menu-status")?.focus();\nview.current?.querySelector("textarea")?.focus();',
      };
      original.interfaceDrafts = { vn: original.rootComponent! };
      const updated = upgradeStatusWorld(original);
      for (const root of [updated.rootComponent!, updated.interfaceDrafts!.vn]) {
        expect(root.files['status-sheet.tsx']).toBe(statusTemplates['status-sheet.tsx']);
        for (const name of ['status-data.ts', 'status-view.tsx', 'status-gauge.tsx', 'status-widgets.tsx', 'status-layout.tsx', 'status-config.ts']) {
          expect(root.files[name]).toBe(original.rootComponent!.files[name]);
        }
        expect(root.files['index.tsx']).toContain('querySelector(".vn-back")?.focus({ preventScroll: true })');
        expect(root.files['index.tsx']).toContain('querySelector(".vn-menu-status")?.focus({ preventScroll: true })');
        expect(root.files['index.tsx']).toContain('querySelector("textarea")?.focus();');
        expect(root.compiled).toBeUndefined();
      }
      expect(original.rootComponent!.files['status-sheet.tsx']).toBe(statusTabsV1Templates['status-sheet.tsx']);
      expect(original.rootComponent!.compiled).toBeDefined();
      expect(upgradeStatusWorld(updated)).toBe(updated);
    },
  );
  it('preserves authored and older sheet contracts when helpers are customized', () => {
    for (const sheet of [statusTabsV1Templates['status-sheet.tsx'] + '\n// authored sheet', statusBuilderV1Templates['status-sheet.tsx']]) {
      const original = world();
      original.rootComponent!.files = { ...statusTemplates,
        'status-sheet.tsx': sheet, 'status-data.ts': 'authored normalizer',
        'status-layout.tsx': 'authored layout', 'index.tsx': 'authored entry',
      };
      expect(upgradeStatusWorld(original)).toBe(original);
    }
  });
  it('keeps explicit classic roots untouched while upgrading cached VN roots', () => {
    const original = world();
    const vn = { ...original.rootComponent!, interfaceId: 'vn' as const,
      files: { ...statusTemplates, ...statusTabsV1Templates } };
    const classic = { ...vn, interfaceId: 'classic' as const,
      files: { ...vn.files, 'index.tsx': 'export default function Classic(){return <Chat />;}' } };
    original.rootComponent = classic;
    original.interfaceDrafts = { classic, vn };
    const updated = upgradeStatusWorld(original);
    expect(updated.rootComponent).toBe(classic);
    expect(updated.interfaceDrafts!.classic).toBe(classic);
    expect(updated.interfaceDrafts!.vn.files['status-sheet.tsx']).toBe(statusTemplates['status-sheet.tsx']);
    expect(updated.interfaceDrafts!.vn.compiled).toBeUndefined();
    expect(classic.compiled).toBeDefined();
    expect(upgradeStatusWorld(updated)).toBe(updated);
  });
  it("upgrades class-specific category sizing without changing a saved custom design", () => {
    const original = world();
    original.rootComponent!.files = { ...statusTemplates, ...statusTabsV1Templates,
      "status-layout.tsx": "authored custom tabs", "status-config.ts": "authored settings", "index.tsx": "authored entry" };
    const updated = upgradeStatusWorld(original);
    expect(updated.rootComponent!.files['status-sheet.tsx']).toContain('[role="tablist"][aria-label="Status categories"]');
    for (const name of ['status-layout.tsx', 'status-config.ts', 'index.tsx']) expect(updated.rootComponent!.files[name]).toBe(original.rootComponent!.files[name]);
    expect(updated.rootComponent!.compiled).toBeUndefined();
    expect(upgradeStatusWorld(updated)).toBe(updated);
    const authored = { ...original, rootComponent: { ...original.rootComponent!, files: { ...original.rootComponent!.files, 'status-sheet.tsx': statusTabsV1Templates['status-sheet.tsx'] + '\n// custom sheet' } } };
    expect(upgradeStatusWorld(authored).rootComponent!.files['status-sheet.tsx']).toBe(authored.rootComponent.files['status-sheet.tsx']);
  });
  it("upgrades pre-encounter sheets and data without replacing custom visualization source", () => {
    const original = world();
    original.rootComponent!.files = { ...statusTemplates, ...statusEncounterV0Templates, "status-layout.tsx": "custom social widgets" };
    const updated = upgradeStatusWorld(original);
    expect(updated.rootComponent!.files['status-sheet.tsx']).toBe(statusTemplates['status-sheet.tsx']);
    expect(updated.rootComponent!.files['status-data.ts']).toBe(statusTemplates['status-data.ts']);
    expect(updated.rootComponent!.files['status-layout.tsx']).toBe('custom social widgets');
  });
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
    expect(current.rootComponent!.files["status-sheet.tsx"]).toContain("filterCharacters(statusConfig) : statusConfig}");
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
