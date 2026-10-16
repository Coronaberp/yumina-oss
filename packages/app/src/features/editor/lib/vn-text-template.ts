import settings from "../../../../../../interfaces/vn/text-settings.tsx?raw";
import defaults from "../../../../../../interfaces/vn/text-defaults.ts?raw";
import style from "../../../../../../interfaces/vn/text-style.ts?raw";
import menu from "../../../../../../interfaces/vn/menu-layout.ts?raw";
import { upgradeVnTextFiles } from "../../chat/vn-text-upgrade";

export function withVnTextSettings(files: Record<string, string>): Record<string, string> {
  return upgradeVnTextFiles(files, { "text-settings.tsx": settings, "text-defaults.ts": defaults, "text-style.ts": style, "menu-layout.ts": menu });
}
