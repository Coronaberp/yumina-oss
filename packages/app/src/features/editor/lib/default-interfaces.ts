import type { InterfacePreset } from "./interface-presets";
import { CLASSIC_FILES } from "./interface-presets";

// The VN preset shares its source with the authored VN interface and its tests.
const sources = import.meta.glob("../../../../../../interfaces/vn/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
export function defaultInterface(id: "vn" | "classic"): InterfacePreset {
  if (id === "classic") return { id, name: "Classic", entryFile: "index.tsx", files: { ...CLASSIC_FILES } };
  const files = Object.fromEntries(Object.entries(sources).map(([path, code]) => [path.split("/").at(-1)!, code]));
  files["font.ts"] = 'export const fontRef = "/vn-assets/DejaVuSans.ttf";';
  files["menu-asset.ts"] = 'export const menuRef = "/vn-assets/menu-vn.png";';
  return { id, name: "VN", entryFile: "index.tsx", files };
}
