import { statusWidgetV1Templates } from './status-widget-v1-templates.js';
import { statusBuilderV1Templates } from './status-builder-v1-templates.js';
import { statusSplitPipTemplates, statusMagnitudeV1Templates, statusScrollV1Templates } from './status-split-pip-templates.js';
import type { RootComponent, WorldDefinition } from '../types/index.js';
import { legacyStatusTemplates } from './legacy-status-templates.js';
import { statusTemplates } from './status-templates.generated.js';

/** Introduce the Visualizations-owned content without changing Back/Close or authored content. */
export function installStatusLayoutFiles(files: Record<string, string>, templates: Record<string, string> = statusTemplates): Record<string, string> {
  const sheet = files['status-sheet.tsx'];
  if (!sheet) return files;
  let source = sheet;
  if (!source.includes('from "./status-layout"')) {
    const oldImport = 'import { StatusView } from "./status-view";';
    const oldView = '<StatusView config={statusConfig} variables={api.variables} />';
    if (!source.includes(oldImport) || !source.includes(oldView)) return files;
    source = source.replace(oldImport, 'import StatusLayout from "./status-layout";\nimport { statusStyles } from "./status-view";')
      .replace('onClose, onBack })', 'onClose, onBack, preview = false })')
      .replace(oldView, '<StatusLayout config={statusConfig} variables={api.variables} preview={preview} />')
      .replace('<button className="vn-menu-shade"', '<style>{statusStyles}</style>\n    <button className="vn-menu-shade"');
  }
  const layout = files['status-layout.tsx'] ?? templates['status-layout.tsx'];
  if (!layout || source === sheet && files['status-layout.tsx'] !== undefined) return files;
  return { ...files, 'status-sheet.tsx': source, 'status-layout.tsx': layout };
}

/** Update shipped modules and known Status focus anchors while retaining authored content. */
export function upgradeStatusFiles(files: Record<string, string>, templates: Record<string, string> = statusTemplates): Record<string, string> {
  const standard = (name: string) => {
    const source = files[name];
    return source === undefined || typeof source === "string" && [templates, legacyStatusTemplates, statusWidgetV1Templates, statusBuilderV1Templates, statusSplitPipTemplates, statusMagnitudeV1Templates, statusScrollV1Templates].some(version => source.trim() === version[name]?.trim());
  };
  const names = ['status-data.ts', 'status-view.tsx', 'status-gauge.tsx', 'status-widgets.tsx'];
  // A styled renderer can still use the shared data/widget contract. Preserve
  // authored renderers while updating an entirely shipped helper contract.
  if (!files['status-view.tsx'] || !names.filter(name => name !== 'status-view.tsx').every(standard)) return files;
  let updated = files;
  for (const name of [...names, 'status-sheet.tsx']) {
    if (!standard(name)) continue;
    if (!templates[name] || files[name] === templates[name]) continue;
    if (updated === files) updated = { ...files };
    updated[name] = templates[name];
  }
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.tsx') || !source.includes('StatusSheet api={sceneApi}')) continue;
    const next = source.replace('querySelector(".vn-back")?.focus()', 'querySelector(".vn-back")?.focus({ preventScroll: true })')
      .replace('querySelector(".vn-menu-status")?.focus()', 'querySelector(".vn-menu-status")?.focus({ preventScroll: true })');
    if (next === source) continue;
    if (updated === files) updated = { ...files };
    updated[name] = next;
  }
  return installStatusLayoutFiles(updated, templates);
}

export function upgradeStatusRoot<T extends RootComponent | undefined>(root: T): T {
  if (!root || !root.files || typeof root.files !== "object") return root;
  const files = upgradeStatusFiles(root.files);
  return (files === root.files ? root : { ...root, files, compiled: undefined }) as T;
}

/** All ingress paths, including Studio resumes, see the same renderer before reading or editing. */
export function upgradeStatusWorld(world: WorldDefinition): WorldDefinition {
  const rootComponent = upgradeStatusRoot(world.rootComponent);
  let interfaceDrafts = world.interfaceDrafts;
  for (const [id, root] of Object.entries(world.interfaceDrafts ?? {})) {
    const upgraded = upgradeStatusRoot(root);
    if (upgraded === root) continue;
    if (interfaceDrafts === world.interfaceDrafts) interfaceDrafts = { ...interfaceDrafts };
    interfaceDrafts![id] = upgraded;
  }
  return rootComponent === world.rootComponent && interfaceDrafts === world.interfaceDrafts ? world : { ...world, rootComponent, interfaceDrafts };
}

/** Studio configures these built-ins; it must not rewrite their implementation. */
export function isManagedStatusHelper(files: Record<string, string>, name: string): boolean {
  if (!['status-data.ts', 'status-gauge.tsx', 'status-widgets.tsx', 'status-view.tsx', 'status-sheet.tsx'].includes(name)) return false;
  const source = files[name];
  return typeof source === "string" && [statusTemplates, legacyStatusTemplates, statusWidgetV1Templates, statusBuilderV1Templates, statusSplitPipTemplates, statusMagnitudeV1Templates, statusScrollV1Templates].some(version => source.trim() === version[name]?.trim());
}
