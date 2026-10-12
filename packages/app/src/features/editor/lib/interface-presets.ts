import type { RootComponent, WorldDefinition } from "@yumina/engine";
import { initialStatusConfig, upgradeStatusFiles, STATUS_CONFIG_FILE, writeStatusConfig } from "./status-visualizations";

export type InterfacePreset = Pick<RootComponent, "name" | "entryFile" | "files"> & { id: string };
export const CLASSIC_FILES = { "index.tsx": "export default function MyWorld() {\n  return <Chat />;\n}" };

export function customUiName(value: string): string {
  return Array.from(value.trim()).slice(0, 50).join("");
}

/** Compatibility for cards authored before explicit interface IDs existed. */
export function interfaceKey(root: RootComponent): string {
  if (root.interfaceId) return root.interfaceId;
  const source = root.files["__user-root.tsx"] ?? root.files[root.entryFile] ?? "";
  if (/^export default function \w+\(\)\s*\{\s*return <Chat\s*\/>;?\s*\}$/.test(source.trim())) return "classic";
  if (root.name === "VN" && root.files["passages.ts"] && root.files["sprites.ts"] && root.files["styles.ts"] && /className="vn(?:-root)?"/.test(source)) return "vn";
  return `draft:${root.id}`;
}

/** Presets replace the main interface; installed overlays stay with the card. */
export function withCurrentBundles(target: RootComponent, current: RootComponent, compose: (folders: string[]) => string): RootComponent {
  const bundles = Object.fromEntries(Object.entries(current.files).filter(([name]) => name.startsWith("_bundles/")));
  const folders = Object.keys(bundles).flatMap(name => name.match(/^_bundles\/([^/]+)\/index\.tsx$/)?.[1] ?? []);
  const files = Object.fromEntries(Object.entries(target.files).filter(([name]) => !name.startsWith("_bundles/") && name !== "__user-root.tsx"));
  // A saved composed root's actual main UI is __user-root, not its composer.
  const userEntry = target.files["__user-root.tsx"] ?? target.files[target.entryFile];
  if (folders.length) {
    // Keep the original entry name too, because sibling imports may reference it.
    if (target.entryFile === "index.tsx") files["index.tsx"] = userEntry;
    files["__user-root.tsx"] = target.entryFile === "index.tsx" ? userEntry : `export { default } from "./${target.entryFile}";`;
    files["index.tsx"] = compose(folders.sort());
  } else if (target.files["__user-root.tsx"]) files[target.entryFile] = userEntry;
  return { ...target, entryFile: folders.length ? "index.tsx" : target.entryFile, files: { ...files, ...bundles }, compiled: undefined };
}

export function switchInterface(world: WorldDefinition, id: string, preset: InterfacePreset, compose?: (folders: string[]) => string): WorldDefinition {
  const current = world.rootComponent;
  if (!current || interfaceKey(current) === id) return world;
  const snapshot = { ...current };
  delete snapshot.compiled;
  const drafts = { ...world.interfaceDrafts, [interfaceKey(current)]: snapshot };
  const cached = drafts[id];
  let next: RootComponent = { ...(cached ?? preset), id: current.id, interfaceId: id, updatedAt: new Date().toISOString() };
  if (id === "vn" && !cached && next.files[STATUS_CONFIG_FILE]) next = { ...next, files: { ...next.files, [STATUS_CONFIG_FILE]: writeStatusConfig(initialStatusConfig(world.variables)) } };
  if (id === "vn" && preset.files["status-widgets.tsx"]) next = { ...next, files: upgradeStatusFiles(next.files, preset.files), compiled: undefined };
  if (compose) next = withCurrentBundles(next, current, compose);
  return { ...world, interfaceDrafts: drafts, rootComponent: { ...next, compiled: undefined } };
}
